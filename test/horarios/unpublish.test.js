import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";

const { createHorariosRepo } = await import("../../src/modules/horarios/horarios.supabase.js");
const { createHorariosService } = await import("../../src/modules/horarios/horarios.service.js");
const { createHorariosRouter } = await import("../../src/modules/horarios/horarios.routes.js");
const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createHttpError } = await import("../../src/shared/http/HttpError.js");

const U = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const ADMIN = U("1"), PLANNER = U("2"), VIEWER = U("3"), STRANGER = U("4"), SCHED = U("a");
const W = "2031-01-06";
const NAMES = { [ADMIN]: "Ana Admin", [PLANNER]: "Paula Planner" };
const code = (status, c) => (e) => e.statusCode === status && e.code === c && e.expose === true;

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------
function fakeClient({ tables = {}, rpcs = {} } = {}) {
  const log = [];
  const builder = (result) =>
    new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve(result).then(res, rej);
        return (...args) => (log.push([prop, ...args]), builder(result));
      },
    });
  return {
    log,
    client: {
      from: (t) => (log.push(["from", t]), builder(tables[t] ?? { data: null, error: null })),
      rpc: (n, a) => (log.push(["rpc", n, a]), Promise.resolve(rpcs[n] ?? { data: null, error: null })),
    },
  };
}
const has = (log, ...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));
const unpublish = (client) => createHorariosRepo(client).unpublishWeek({ sedeId: "copacabana", weekStart: W, expectedVersion: 4, actor: ADMIN });

test("repo.unpublishWeek calls shifts_unpublish_week with the exact parameter names", async () => {
  const { log, client } = fakeClient({ rpcs: { shifts_unpublish_week: { data: { id: SCHED, version: 5 }, error: null } } });
  assert.deepEqual(await unpublish(client), { id: SCHED, version: 5 });
  assert.deepEqual(log, [["rpc", "shifts_unpublish_week", { p_sede: "copacabana", p_week: W, p_expected_version: 4, p_actor: ADMIN }]]);
});

test("repo.unpublishWeek maps the RPC exceptions to HTTP errors", async () => {
  const fail = (message, details) => fakeClient({ rpcs: { shifts_unpublish_week: { data: null, error: { message, details } } } }).client;
  await assert.rejects(unpublish(fail("SCHEDULE_NOT_FOUND")), code(404, "SCHEDULE_NOT_FOUND"));
  await assert.rejects(unpublish(fail("NOT_PUBLISHED")), (e) => code(409, "NOT_PUBLISHED")(e) && e.message === "Este horario no está publicado.");
  await assert.rejects(unpublish(fail("VERSION_CONFLICT", "7")), (e) => code(409, "VERSION_CONFLICT")(e) && e.details.currentVersion === 7);
  await assert.rejects(unpublish(fail("PAYROLL_CUT_PAID", "12")), (e) =>
    code(409, "PAYROLL_CUT_PAID")(e) && e.message === "No puedes despublicar: esta semana ya está en un corte de nómina pagado." && e.details.cut.id === 12);
  const boom = new Error("db down");
  await assert.rejects(unpublish(fail("db down")), (e) => e.message === boom.message);
});

test("repo.findPaidCutOverlapping asks only for PAGADO cuts that share a day with the range", async () => {
  const row = { id: "9", period_start: "2031-01-06", period_end: "2031-01-12" };
  const { log, client } = fakeClient({ tables: { payroll_cuts: { data: row, error: null } } });
  assert.deepEqual(await createHorariosRepo(client).findPaidCutOverlapping(W, "2031-01-12"), { id: 9, from: "2031-01-06", to: "2031-01-12" });
  assert.ok(has(log, "from", "payroll_cuts"));
  assert.ok(has(log, "eq", "state", "PAGADO"), "voided cuts never block");
  assert.ok(has(log, "lte", "period_start", "2031-01-12"));
  assert.ok(has(log, "gte", "period_end", W));
  assert.equal(await createHorariosRepo(fakeClient().client).findPaidCutOverlapping(W, "2031-01-12"), null);
  await assert.rejects(createHorariosRepo(fakeClient({ tables: { payroll_cuts: { data: null, error: new Error("x") } } }).client).findPaidCutOverlapping(W, W), /x/);
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
const access = {
  admin: { role: "admin", sedeIds: null },
  planner: { role: "planner", sedeIds: ["copacabana"] },
  plannerOther: { role: "planner", sedeIds: ["las-vegas"] },
  viewer: { role: "viewer", sedeIds: ["copacabana"] },
};
const published = (over = {}) => ({
  id: SCHED, sede_id: "copacabana", week_start: W, state: "PUBLICADO", version: 4, published_by: ADMIN, published_at: "2031-01-03T15:00:00+00:00",
  created_by: ADMIN, created_at: "t0", updated_by: PLANNER, updated_at: "t1", ...over,
});

function fakes({ schedule = published(), paidCut = null, sedes = ["copacabana", "las-vegas"] } = {}) {
  const state = { schedule, history: [] };
  const calls = [];
  const repo = {
    calls,
    state,
    async findSede(id) { calls.push(["findSede", id]); return sedes.includes(id) ? { sede_id: id } : null; },
    async findSchedule() { calls.push(["findSchedule"]); return state.schedule; },
    async findPaidCutOverlapping(from, to) { calls.push(["findPaidCutOverlapping", from, to]); return paidCut; },
    async unpublishWeek(args) {
      calls.push(["unpublishWeek", args]);
      state.schedule = { ...state.schedule, state: "BORRADOR", version: state.schedule.version + 1, published_by: null, published_at: null, updated_by: args.actor, updated_at: "t5" };
      state.history.push({ action: "DESPUBLICAR", actor: args.actor, schedule_version: state.schedule.version });
      return { id: SCHED, version: state.schedule.version };
    },
  };
  const profilesRepo = { async findById(id) { return NAMES[id] ? { nombre: NAMES[id] } : null; } };
  return { repo, calls, service: createHorariosService({ repo, profilesRepo }) };
}
const names = (calls) => calls.map((c) => c[0]);

test("service.unpublish returns the schedule DTO back in BORRADOR with version + 1 and the published fields cleared", async () => {
  const { service, repo } = fakes();
  const out = await service.unpublish(access.planner, { id: PLANNER }, "copacabana", W, { expectedVersion: 4 });
  assert.deepEqual(out, {
    schedule: {
      sedeId: "copacabana", weekStart: W, state: "BORRADOR", version: 5,
      updatedBy: PLANNER, updatedByName: "Paula Planner", updatedAt: "t5",
      publishedBy: null, publishedByName: null, publishedAt: null,
    },
    warnings: [],
  });
  assert.deepEqual(repo.calls.find((c) => c[0] === "unpublishWeek")[1], { sedeId: "copacabana", weekStart: W, expectedVersion: 4, actor: PLANNER });
  assert.deepEqual(repo.state.history, [{ action: "DESPUBLICAR", actor: PLANNER, schedule_version: 5 }]);
});

test("service.unpublish checks the paid cut against the Monday..Sunday of the week", async () => {
  const { service, repo } = fakes();
  await service.unpublish(access.admin, { id: ADMIN }, "copacabana", W, { expectedVersion: 4 });
  assert.deepEqual(repo.calls.find((c) => c[0] === "findPaidCutOverlapping"), ["findPaidCutOverlapping", W, "2031-01-12"]);
});

test("service.unpublish: a week with a PAGADO cut is 409 PAYROLL_CUT_PAID with the cut, and nothing is written", async () => {
  const { service, repo } = fakes({ paidCut: { id: 9, from: "2031-01-06", to: "2031-01-12" } });
  await assert.rejects(service.unpublish(access.admin, { id: ADMIN }, "copacabana", W, { expectedVersion: 4 }), (e) =>
    code(409, "PAYROLL_CUT_PAID")(e) &&
    e.message === "No puedes despublicar: esta semana ya está en un corte de nómina pagado." &&
    JSON.stringify(e.details) === JSON.stringify({ cut: { id: 9, from: "2031-01-06", to: "2031-01-12" } }));
  assert.equal(names(repo.calls).includes("unpublishWeek"), false);
});

test("service.unpublish: a voided cut does not block (the repo only returns PAGADO cuts, so no cut came back)", async () => {
  const { service } = fakes({ paidCut: null });
  const out = await service.unpublish(access.admin, { id: ADMIN }, "copacabana", W, { expectedVersion: 4 });
  assert.equal(out.schedule.state, "BORRADOR");
});

test("service.unpublish: no schedule is 404 SCHEDULE_NOT_FOUND", async () => {
  const { service, repo } = fakes({ schedule: null });
  await assert.rejects(service.unpublish(access.admin, { id: ADMIN }, "copacabana", W, { expectedVersion: 1 }), code(404, "SCHEDULE_NOT_FOUND"));
  assert.equal(names(repo.calls).includes("unpublishWeek"), false);
});

test("service.unpublish: a BORRADOR week is 409 NOT_PUBLISHED", async () => {
  const { service, repo } = fakes({ schedule: published({ state: "BORRADOR", published_by: null, published_at: null }) });
  await assert.rejects(service.unpublish(access.admin, { id: ADMIN }, "copacabana", W, { expectedVersion: 4 }), (e) =>
    code(409, "NOT_PUBLISHED")(e) && e.message === "Este horario no está publicado.");
  assert.equal(names(repo.calls).includes("unpublishWeek"), false);
});

test("service.unpublish: a stale expectedVersion is 409 VERSION_CONFLICT with the current version", async () => {
  const { service, repo } = fakes();
  await assert.rejects(service.unpublish(access.admin, { id: ADMIN }, "copacabana", W, { expectedVersion: 3 }), (e) =>
    code(409, "VERSION_CONFLICT")(e) &&
    e.message === "Otra persona guardó cambios en este horario. Carga la versión guardada para continuar." &&
    e.details.currentVersion === 4);
  assert.equal(names(repo.calls).includes("unpublishWeek"), false);
});

test("service.unpublish: viewers and planners of another sede are 403; an unknown sede is 404", async () => {
  for (const [a, c] of [[access.viewer, "FORBIDDEN_ROLE"], [access.plannerOther, "FORBIDDEN_SEDE"]]) {
    const { service, repo } = fakes();
    await assert.rejects(service.unpublish(a, { id: VIEWER }, "copacabana", W, { expectedVersion: 4 }), code(403, c));
    assert.equal(repo.calls.length, 0);
  }
  await assert.rejects(fakes().service.unpublish(access.admin, { id: ADMIN }, "nope", W, { expectedVersion: 4 }), code(404, "SEDE_NOT_FOUND"));
});

test("service.unpublish: errors raised by the RPC under a race (another request got there first) propagate unchanged", async () => {
  const { service, repo } = fakes();
  repo.unpublishWeek = async () => { throw createHttpError(409, "Este horario no está publicado.", "NOT_PUBLISHED"); };
  await assert.rejects(service.unpublish(access.admin, { id: ADMIN }, "copacabana", W, { expectedVersion: 4 }), code(409, "NOT_PUBLISHED"));
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
const TOKENS = { "t-admin": ADMIN, "t-planner": PLANNER, "t-viewer": VIEWER, "t-stranger": STRANGER };
const ROWS = {
  [ADMIN]: { role: "admin", sede_ids: null },
  [PLANNER]: { role: "planner", sede_ids: ["copacabana"] },
  [VIEWER]: { role: "viewer", sede_ids: ["copacabana"] },
};

async function withApp(fn) {
  const calls = [];
  const service = { async unpublish(...args) { calls.push(args); return { schedule: { state: "BORRADOR" }, warnings: [] }; } };
  const router = createHorariosRouter({
    authenticate: createAuthenticate({ verifyToken: async (t) => (TOKENS[t] ? { id: TOKENS[t], email: "x@x.co" } : null) }),
    accessRepo: { async findByUserId(id) { return ROWS[id] ? { user_id: id, ...ROWS[id], revoked_at: null } : null; } },
    service,
  });
  const server = createApp({ routes: createRoutes({ modules: { "/horarios": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/horarios`;
  const call = async (path, token, json) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ call, calls });
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const p = (sede = "copacabana", week = W) => `/sedes/${sede}/weeks/${week}/unpublish`;
const BODY = { expectedVersion: 4 };

test("route: 401 without or with a bad token; 403 without an access row; the service is never reached", () =>
  withApp(async ({ call, calls }) => {
    assert.equal((await call(p(), null, BODY)).status, 401);
    assert.equal((await call(p(), "bogus", BODY)).status, 401);
    assert.equal((await call(p(), "t-stranger", BODY)).status, 403);
    assert.equal(calls.length, 0);
  }));

test("route: viewers are 403 FORBIDDEN_ROLE, scoped users on another sede 403 FORBIDDEN_SEDE, even with an invalid body", () =>
  withApp(async ({ call, calls }) => {
    const v = await call(p(), "t-viewer", { expectedVersion: 0 });
    assert.deepEqual([v.status, v.json.code], [403, "FORBIDDEN_ROLE"]);
    const s = await call(p("las-vegas"), "t-planner", BODY);
    assert.deepEqual([s.status, s.json.code], [403, "FORBIDDEN_SEDE"]);
    assert.equal(calls.length, 0);
  }));

test("route: planners (own sede) and admins (any sede) unpublish; the answer is { data: { schedule }, warnings }", () =>
  withApp(async ({ call, calls }) => {
    const a = await call(p(), "t-planner", BODY);
    assert.equal(a.status, 200);
    assert.deepEqual(a.json, { data: { schedule: { state: "BORRADOR" } }, warnings: [] });
    assert.equal((await call(p("las-vegas"), "t-admin", BODY)).status, 200);
    assert.deepEqual(calls[0], [{ role: "planner", sedeIds: ["copacabana"] }, { id: PLANNER, email: "x@x.co" }, "copacabana", W, { expectedVersion: 4 }]);
    assert.equal(calls[1][2], "las-vegas");
  }));

test("route: an invalid weekStart or body is 400 VALIDATION_ERROR", () =>
  withApp(async ({ call, calls }) => {
    for (const [path, body] of [[p("copacabana", "2031-01-07"), BODY], [p(), { expectedVersion: 0 }], [p(), {}], [p(), { expectedVersion: "4" }], [p(), undefined]]) {
      const r = await call(path, "t-planner", body);
      assert.deepEqual([r.status, r.json.code], [400, "VALIDATION_ERROR"], JSON.stringify([path, body]));
    }
    assert.equal(calls.length, 0);
  }));

// ---------------------------------------------------------------------------
// Migration 010 (static)
// ---------------------------------------------------------------------------
const read = (rel) => readFileSync(new URL(`../../db/${rel}`, import.meta.url), "utf8");
const flat = (s) => s.toLowerCase().replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
const sql = flat(read("migrations/010_unpublish_schedule.sql"));
const fn = /create or replace function shifts_unpublish_week\(([\s\S]*?)\$\$;/i.exec(flat(read("migrations/010_unpublish_schedule.sql")))?.[0] ?? "";

test("migration 010: same advisory lock and row lock as publish, in the same key space", () => {
  assert.ok(fn, "function found");
  assert.ok(fn.includes("pg_advisory_xact_lock(hashtext('shifts:week:' || p_sede || ':' || to_char(p_week, 'yyyy-mm-dd')))"));
  assert.ok(fn.includes("for update"));
});

test("migration 010: every error, in order, and the state change", () => {
  const order = ["schedule_not_found", "not_published", "version_conflict", "payroll_cut_paid"].map((m) => fn.indexOf(`raise exception '${m}'`));
  assert.ok(order.every((i) => i > 0) && [...order].sort((a, b) => a - b).join() === order.join(), "all raised, in contract order");
  assert.ok(fn.includes("state = 'borrador', published_by = null, published_at = null"));
  assert.ok(fn.includes("version = version + 1"));
  assert.ok(fn.includes("'despublicar'"));
});

test("migration 010: only PAGADO cuts overlapping the week block; ANULADO never does", () => {
  assert.ok(fn.includes("from payroll_cuts where state = 'pagado' and period_start <= p_week + 6 and period_end >= p_week"));
  assert.ok(!fn.includes("anulado"));
});

test("migration 010: history accepts DESPUBLICAR with a schedule-level shape; the old actions keep their shape", () => {
  assert.ok(sql.includes("check (action in ('crear','editar','eliminar','editar_publicado','publicar','despublicar'))"));
  assert.ok(sql.includes("(action = 'despublicar' and shift_id is null and cedula is null and fecha is null and before is not null and after is not null)"));
  for (const a of ["'crear'", "'editar'", "'eliminar'", "'editar_publicado'"]) assert.ok(sql.includes(`action = ${a}`), a);
});

test("migration 010: service_role only; the shifts are not touched by the function", () => {
  assert.ok(sql.includes("revoke all on function shifts_unpublish_week(text, date, int, uuid) from public"));
  assert.ok(sql.includes("revoke all on function shifts_unpublish_week(text, date, int, uuid) from anon, authenticated"));
  assert.ok(sql.includes("grant execute on function shifts_unpublish_week(text, date, int, uuid) to service_role"));
  assert.ok(!/(update|delete from|insert into) shifts\b/.test(fn));
});

test("migration 010: rollback snapshots the DESPUBLICAR rows first and restores the 004 constraints; verify ends in ROLLBACK", () => {
  const d = flat(read("migrations/rollback/010_unpublish_schedule.down.sql"));
  assert.ok(d.indexOf("shift_history_backup_010") < d.indexOf("delete from shift_history where action = 'despublicar'"));
  assert.ok(d.includes("drop function if exists shifts_unpublish_week(text, date, int, uuid)"));
  assert.ok(d.includes("check (action in ('crear','editar','eliminar','editar_publicado','publicar'))"));
  assert.ok(!d.includes("(action = 'despublicar'"));
  const v = flat(read("verification/010_unpublish_schedule_verify.sql")).trim();
  assert.match(v, /^begin;/);
  assert.match(v, /rollback;$/);
  assert.ok(v.includes("all checks passed"));
});
