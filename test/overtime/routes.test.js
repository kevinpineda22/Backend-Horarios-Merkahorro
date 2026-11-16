import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createOvertimeRouter, requestBodySchema, decisionBodySchema } = await import("../../src/modules/overtime/overtime.routes.js");
const { createOvertimeRepo } = await import("../../src/modules/overtime/overtime.supabase.js");
const { createMailer } = await import("../../src/shared/email/mailer.js");

const U = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;

// ---------------------------------------------------------------- schemas

test("request body: hours > 0, at most 100, in half-hour steps; a reason up to 500 characters", () => {
  assert.deepEqual(requestBodySchema.parse({ hours: 6.5, motivo: "  Temporada  " }), { hours: 6.5, motivo: "Temporada" });
  for (const body of [{ hours: 0, motivo: "m" }, { hours: 101, motivo: "m" }, { hours: 2.25, motivo: "m" }, { hours: "4", motivo: "m" }, { hours: 4, motivo: "  " }, { hours: 4, motivo: "x".repeat(501) }, { hours: 4 }]) {
    assert.equal(requestBodySchema.safeParse(body).success, false, JSON.stringify(body));
  }
});

test("decision body: APROBADA or RECHAZADA, optional comment (blank = none)", () => {
  assert.deepEqual(decisionBodySchema.parse({ decision: "APROBADA", comment: "  " }), { decision: "APROBADA", comment: null });
  assert.equal(decisionBodySchema.safeParse({ decision: "PENDIENTE" }).success, false);
});

// ---------------------------------------------------------------- routes

const TOKENS = { "t-planner": U("2"), "t-anny": U("5"), "t-stranger": U("7") };
const EMAILS = { [U("2")]: "lider@merkahorrosas.com", [U("5")]: "analista@merkahorrosas.com", [U("7")]: "otro@merkahorrosas.com" };
const ACCESS = { [U("2")]: { role: "planner", sede_ids: ["copacabana"] } };

async function withApp(fn) {
  const calls = [];
  const service = {
    async me(user) { calls.push(["me", user.email]); return { isApprover: user.email === "analista@merkahorrosas.com" }; },
    async forWeek(access, sedeId, weekStart) { calls.push(["forWeek", sedeId, weekStart]); return { items: [], approvedHours: 0 }; },
    async request(access, user, sedeId, weekStart, body) { calls.push(["request", sedeId, weekStart, body]); return { request: { id: "r1" }, emailSent: true }; },
    async listForApprovers(user, query) { calls.push(["list", user.email, query]); return []; },
    async decide(user, id, body) { calls.push(["decide", user.email, id, body]); return { request: { id }, emailSent: true }; },
  };
  const router = createOvertimeRouter({
    authenticate: createAuthenticate({ verifyToken: async (t) => (TOKENS[t] ? { id: TOKENS[t], email: EMAILS[TOKENS[t]] } : null) }),
    accessRepo: { findByUserId: async (id) => ACCESS[id] ?? null },
    service,
  });
  const server = createApp({ routes: createRoutes({ modules: { "/overtime": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/overtime`;
  const call = async (method, path, token, json) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ call, calls });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("routes: a leader asks (201) and reads a week; Monday and body are validated; another sede is 403", () =>
  withApp(async ({ call, calls }) => {
    const ok = await call("POST", "/sedes/copacabana/weeks/2026-11-23", "t-planner", { hours: 4, motivo: "x" });
    assert.equal(ok.status, 201);
    assert.deepEqual(calls.at(-1), ["request", "copacabana", "2026-11-23", { hours: 4, motivo: "x" }]);
    assert.equal((await call("GET", "/sedes/copacabana/weeks/2026-11-23", "t-planner")).status, 200);
    assert.equal((await call("POST", "/sedes/copacabana/weeks/2026-11-24", "t-planner", { hours: 4, motivo: "x" })).status, 400);
    assert.equal((await call("POST", "/sedes/copacabana/weeks/2026-11-23", "t-planner", { hours: 0, motivo: "x" })).status, 400);
    assert.equal((await call("POST", "/sedes/las-vegas/weeks/2026-11-23", "t-planner", { hours: 4, motivo: "x" })).status, 403);
  }));

test("routes: approvers need no access row; me / list / decide only authenticate (the service checks the e-mail)", () =>
  withApp(async ({ call, calls }) => {
    assert.deepEqual((await call("GET", "/me", "t-anny")).json.data, { isApprover: true });
    assert.equal((await call("GET", "/requests?status=PENDIENTE", "t-anny")).status, 200);
    assert.deepEqual(calls.at(-1), ["list", "analista@merkahorrosas.com", { status: "PENDIENTE" }]);
    const decided = await call("POST", `/requests/${U("9")}/decision`, "t-anny", { decision: "RECHAZADA", comment: "No" });
    assert.equal(decided.status, 200);
    assert.equal((await call("POST", "/requests/x/decision", "t-anny", { decision: "APROBADA" })).status, 400);
    assert.equal((await call("GET", "/me", null)).status, 401);
    // Without an access row, the leader routes are closed.
    assert.equal((await call("GET", "/sedes/copacabana/weeks/2026-11-23", "t-anny")).status, 403);
  }));

// ---------------------------------------------------------------- repo

function fakeClient(results) {
  const log = [];
  const builder = (result) =>
    new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve(result).then(res, rej);
        return (...args) => (log.push([prop, ...args]), builder(result));
      },
    });
  const queue = results.slice();
  return { log, client: { from: (t) => (log.push(["from", t]), builder(queue.shift() ?? { data: null, error: null })) } };
}
const ROW = { id: U("9"), sede_id: "copacabana", week_start: "2026-11-23", hours: "6.5", motivo: "m", status: "PENDIENTE", requested_by: U("2"), requested_at: "2026-11-16T15:00:00+00:00", decided_by: null, decided_at: null, decision_comment: null };
const has = (log, ...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));

test("repo: rows to camelCase with numeric hours; a duplicate pending request is 409", async () => {
  const created = await createOvertimeRepo(fakeClient([{ data: ROW, error: null }]).client).create({ sedeId: "copacabana", weekStart: "2026-11-23", hours: 6.5, motivo: "m", requestedBy: U("2") });
  assert.deepEqual([created.hours, created.weekStart, created.requestedAt], [6.5, "2026-11-23", "2026-11-16T15:00:00.000Z"]);
  await assert.rejects(
    createOvertimeRepo(fakeClient([{ data: null, error: { code: "23505" } }]).client).create({ sedeId: "s", weekStart: "w", hours: 1, motivo: "m", requestedBy: "u" }),
    (e) => e.statusCode === 409 && e.code === "OVERTIME_REQUEST_PENDING",
  );
});

test("repo.decide: only a PENDIENTE row; null when another approver decided first", async () => {
  const ok = fakeClient([{ data: [{ ...ROW, status: "APROBADA", decided_by: U("5"), decided_at: "2026-11-16T16:00:00+00:00" }], error: null }]);
  const row = await createOvertimeRepo(ok.client).decide({ id: U("9"), status: "APROBADA", decidedBy: U("5"), comment: null });
  assert.equal(row.status, "APROBADA");
  assert.ok(has(ok.log, "eq", "status", "PENDIENTE"));
  assert.equal(await createOvertimeRepo(fakeClient([{ data: [], error: null }]).client).decide({ id: U("9"), status: "APROBADA", decidedBy: U("5") }), null);
});

// ---------------------------------------------------------------- mailer

test("mailer: disabled without credentials; with them it sends from EMAIL_USER to every recipient", async () => {
  await assert.rejects(createMailer({}).send({ to: ["a@x.co"], subject: "s", html: "h" }), (e) => e.code === "MAIL_NOT_CONFIGURED");
  const sent = [];
  const mailer = createMailer({ EMAIL_USER: "app@merkahorrosas.com", EMAIL_PASS: "p" }, { createTransport: (opts) => ({ opts, sendMail: async (m) => sent.push(m) }) });
  assert.equal(mailer.configured, true);
  await mailer.send({ to: ["a@x.co", "b@x.co"], subject: "Hola", html: "<p>h</p>", text: "h" });
  assert.deepEqual(sent[0], { from: '"Programador de horarios" <app@merkahorrosas.com>', to: "a@x.co, b@x.co", subject: "Hola", html: "<p>h</p>", text: "h" });
});

// ---------------------------------------------------------------- migration 014 (static)

const read = (rel) => readFileSync(new URL(`../../db/${rel}`, import.meta.url), "utf8");
const flat = (s) => s.toLowerCase().replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

test("migration 014: requests table with one pending per sede-week, decision columns together, closed to clients", () => {
  const sql = flat(read("migrations/014_overtime_requests.sql"));
  assert.ok(sql.includes("create table if not exists overtime_requests ("));
  assert.ok(sql.includes("check (hours > 0 and hours <= 100)"));
  assert.ok(sql.includes("check (status in ('pendiente', 'aprobada', 'rechazada'))"));
  assert.ok(sql.includes("create unique index if not exists overtime_requests_pending_idx on overtime_requests (sede_id, week_start) where status = 'pendiente'"));
  assert.ok(sql.includes("alter table overtime_requests enable row level security"));
  assert.ok(sql.includes("revoke all on table overtime_requests from anon, authenticated"));
  assert.doesNotMatch(sql, /create policy/);
  assert.match(read("migrations/014_overtime_requests.sql"), /apply this BEFORE deploying the backend/i);
  const d = flat(read("migrations/rollback/014_overtime_requests.down.sql"));
  assert.ok(d.indexOf("overtime_requests_backup_014") < d.indexOf("drop table if exists overtime_requests"));
  const v = flat(read("verification/014_overtime_requests_verify.sql")).trim();
  assert.match(v, /^begin;/);
  assert.match(v, /rollback;$/);
  assert.ok(v.includes("all checks passed"));
});

test("mailer: SMTP_HOST / SMTP_PORT / SMTP_SECURE work like EMAIL_*; EMAIL_* wins when both are set", async () => {
  const opts = [];
  const make = (env) => createMailer({ EMAIL_USER: "u@x.co", EMAIL_PASS: "p", ...env }, { createTransport: (o) => (opts.push(o), { sendMail: async () => {} }) });
  await make({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_SECURE: "true" }).send({ to: ["a@x.co"], subject: "s", html: "h" });
  assert.deepEqual([opts[0].host, opts[0].port, opts[0].secure], ["smtp.example.com", 465, true]);
  await make({ EMAIL_HOST: "mail.a.co", SMTP_HOST: "mail.b.co" }).send({ to: ["a@x.co"], subject: "s", html: "h" });
  assert.deepEqual([opts[1].host, opts[1].port, opts[1].secure], ["mail.a.co", 587, false]);
});
