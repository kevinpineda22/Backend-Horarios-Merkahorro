import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";

const { schedulesListQuerySchema, sedeParamsSchema } = await import("../../src/modules/horarios/horarios.schemas.js");
const { createHorariosRepo } = await import("../../src/modules/horarios/horarios.supabase.js");
const { createHorariosService } = await import("../../src/modules/horarios/horarios.service.js");
const { createHorariosRouter } = await import("../../src/modules/horarios/horarios.routes.js");
const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");

const U = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const ADMIN = U("1"), PLANNER = U("2"), VIEWER = U("3"), STRANGER = U("4"), S1 = U("a"), S2 = U("b"), S3 = U("c");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
test("schema: status defaults to PUBLICADO and accepts only the real states", () => {
  assert.equal(schedulesListQuerySchema.parse({}).status, "PUBLICADO");
  assert.equal(schedulesListQuerySchema.parse({ status: "BORRADOR" }).status, "BORRADOR");
  for (const status of ["publicado", "ARCHIVADO", "", "PUBLICADO,BORRADOR"]) {
    assert.equal(schedulesListQuerySchema.safeParse({ status }).success, false, status);
  }
});

test("schema: limit is 1..52, default 26, digits only", () => {
  assert.equal(schedulesListQuerySchema.parse({}).limit, 26);
  assert.equal(schedulesListQuerySchema.parse({ limit: "1" }).limit, 1);
  assert.equal(schedulesListQuerySchema.parse({ limit: "52" }).limit, 52);
  for (const limit of ["0", "53", "-1", "2.5", "abc", ""]) {
    assert.equal(schedulesListQuerySchema.safeParse({ limit }).success, false, limit);
  }
});

test("schema: sede params need a non-blank sedeId", () => {
  assert.equal(sedeParamsSchema.parse({ sedeId: " copacabana " }).sedeId, "copacabana");
  assert.equal(sedeParamsSchema.safeParse({ sedeId: "  " }).success, false);
});

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
      from: (t) => (log.push(["from", t]), builder(tables[t] ?? { data: [], error: null })),
      rpc: (n, a) => (log.push(["rpc", n, a]), Promise.resolve(rpcs[n] ?? { data: [], error: null })),
    },
  };
}
const has = (log, ...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));

test("repo.listSchedules: ONE query filtered by sede and state, newest week first, limited", async () => {
  const rows = [{ id: S1, week_start: "2031-01-13" }];
  const { log, client } = fakeClient({ tables: { sede_week_schedules: { data: rows, error: null } } });
  const out = await createHorariosRepo(client).listSchedules({ sedeId: "copacabana", status: "PUBLICADO", limit: 26 });
  assert.deepEqual(out, rows);
  assert.equal(log.filter((c) => c[0] === "from").length, 1);
  assert.ok(has(log, "from", "sede_week_schedules"));
  assert.ok(has(log, "eq", "sede_id", "copacabana"));
  assert.ok(has(log, "eq", "state", "PUBLICADO"));
  assert.ok(has(log, "order", "week_start", { ascending: false }));
  assert.ok(has(log, "limit", 26));
  const select = log.find((c) => c[0] === "select")[1];
  for (const col of ["id", "week_start", "state", "version", "published_by", "published_at"]) assert.match(select, new RegExp(`\\b${col}\\b`));
});

test("repo.listSchedules: errors propagate and null data is an empty list", async () => {
  const boom = new Error("down");
  await assert.rejects(createHorariosRepo(fakeClient({ tables: { sede_week_schedules: { data: null, error: boom } } }).client).listSchedules({ sedeId: "x", status: "PUBLICADO", limit: 5 }), /down/);
  assert.deepEqual(await createHorariosRepo(fakeClient({ tables: { sede_week_schedules: { data: null, error: null } } }).client).listSchedules({ sedeId: "x", status: "PUBLICADO", limit: 5 }), []);
});

test("repo.countPeople: ONE rpc for all schedules, returned as { scheduleId: n }", async () => {
  const { log, client } = fakeClient({ rpcs: { shifts_people_counts: { data: [{ schedule_id: S1, people: 12 }, { schedule_id: S2, people: "7" }], error: null } } });
  const out = await createHorariosRepo(client).countPeople([S1, S2, S3]);
  assert.deepEqual(out, { [S1]: 12, [S2]: 7 });
  assert.deepEqual(log, [["rpc", "shifts_people_counts", { p_schedule_ids: [S1, S2, S3] }]]);
});

test("repo.countPeople: no ids means no call; errors propagate", async () => {
  const { log, client } = fakeClient();
  assert.deepEqual(await createHorariosRepo(client).countPeople([]), {});
  assert.equal(log.length, 0);
  await assert.rejects(createHorariosRepo(fakeClient({ rpcs: { shifts_people_counts: { data: null, error: new Error("nope") } } }).client).countPeople([S1]), /nope/);
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
const NAMES = { [ADMIN]: "Ana Admin" };
const access = {
  admin: { role: "admin", sedeIds: null },
  planner: { role: "planner", sedeIds: ["copacabana"] },
  plannerOther: { role: "planner", sedeIds: ["las-vegas"] },
  viewer: { role: "viewer", sedeIds: ["copacabana"] },
};
const sch = (id, weekStart, over = {}) => ({
  id, sede_id: "copacabana", week_start: weekStart, state: "PUBLICADO", version: 3, published_by: ADMIN, published_at: "2031-01-10T15:00:00+00:00",
  created_by: ADMIN, created_at: "t", updated_by: ADMIN, updated_at: "t", ...over,
});

function fakes({ schedules = [], counts = {}, sedes = ["copacabana", "las-vegas"], names = NAMES } = {}) {
  const calls = [];
  const repo = {
    calls,
    async findSede(id) { calls.push(["findSede", id]); return sedes.includes(id) ? { sede_id: id } : null; },
    async listSchedules(args) { calls.push(["listSchedules", args]); return schedules; },
    async countPeople(ids) { calls.push(["countPeople", ids]); return counts; },
  };
  const profilesRepo = { async findById(id) { calls.push(["profile", id]); return names[id] ? { nombre: names[id] } : null; } };
  return { repo, calls, service: createHorariosService({ repo, profilesRepo }) };
}

test("service.listSchedules maps the contract shape, newest week first as the repo returned them", async () => {
  const { service } = fakes({
    schedules: [sch(S1, "2031-01-13"), sch(S2, "2031-01-06", { state: "BORRADOR", version: 1, published_by: null, published_at: null })],
    counts: { [S1]: 14, [S2]: 3 },
  });
  const out = await service.listSchedules(access.viewer, "copacabana", { status: "PUBLICADO", limit: 26 });
  assert.deepEqual(out, [
    { weekStart: "2031-01-13", status: "PUBLICADO", version: 3, publishedAt: "2031-01-10T15:00:00.000Z", publishedBy: "Ana Admin", peopleCount: 14 },
    { weekStart: "2031-01-06", status: "BORRADOR", version: 1, publishedAt: null, publishedBy: null, peopleCount: 3 },
  ]);
});

test("service.listSchedules: unknown publisher name -> null; schedule without rows -> peopleCount 0", async () => {
  const { service } = fakes({ schedules: [sch(S1, "2031-01-13", { published_by: U("9") })], counts: {} });
  const [item] = await service.listSchedules(access.admin, "copacabana", { status: "PUBLICADO", limit: 5 });
  assert.deepEqual([item.publishedBy, item.peopleCount], [null, 0]);
});

test("service.listSchedules: two repo calls in total (no N+1) and each publisher is resolved once", async () => {
  const { service, calls } = fakes({ schedules: [sch(S1, "2031-01-13"), sch(S2, "2031-01-06"), sch(S3, "2030-12-30")], counts: { [S1]: 1, [S2]: 1, [S3]: 1 } });
  await service.listSchedules(access.admin, "copacabana", { status: "PUBLICADO", limit: 26 });
  assert.deepEqual(calls.filter((c) => c[0] === "listSchedules").map((c) => c[1]), [{ sedeId: "copacabana", status: "PUBLICADO", limit: 26 }]);
  assert.equal(calls.filter((c) => c[0] === "countPeople").length, 1);
  assert.deepEqual(calls.find((c) => c[0] === "countPeople")[1], [S1, S2, S3]);
  assert.equal(calls.filter((c) => c[0] === "profile").length, 1);
});

test("service.listSchedules: an empty list skips the count query", async () => {
  const { service, calls } = fakes();
  assert.deepEqual(await service.listSchedules(access.admin, "copacabana", { status: "PUBLICADO", limit: 26 }), []);
  assert.equal(calls.some((c) => c[0] === "countPeople"), false);
});

test("service.listSchedules: another sede is 403 FORBIDDEN_SEDE before any query; unknown sede is 404 SEDE_NOT_FOUND", async () => {
  const { service, calls } = fakes();
  await assert.rejects(service.listSchedules(access.plannerOther, "copacabana", { status: "PUBLICADO", limit: 5 }), (e) => e.statusCode === 403 && e.code === "FORBIDDEN_SEDE");
  assert.equal(calls.length, 0);
  await assert.rejects(service.listSchedules(access.admin, "nope", { status: "PUBLICADO", limit: 5 }), (e) => e.statusCode === 404 && e.code === "SEDE_NOT_FOUND");
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
  const service = { async listSchedules(...args) { calls.push(args); return [{ weekStart: "2031-01-06" }]; } };
  const router = createHorariosRouter({
    authenticate: createAuthenticate({ verifyToken: async (t) => (TOKENS[t] ? { id: TOKENS[t], email: "x@x.co" } : null) }),
    accessRepo: { async findByUserId(id) { return ROWS[id] ? { user_id: id, ...ROWS[id], revoked_at: null } : null; } },
    service,
  });
  const server = createApp({ routes: createRoutes({ modules: { "/horarios": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/horarios`;
  const call = async (path, token) => {
    const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ call, calls });
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const p = (sede = "copacabana", qs = "") => `/sedes/${sede}/schedules${qs}`;

test("route: 401 without or with a bad token, 403 without an access row; the service is never reached", () =>
  withApp(async ({ call, calls }) => {
    assert.equal((await call(p())).status, 401);
    assert.equal((await call(p(), "bogus")).status, 401);
    const r = await call(p(), "t-stranger");
    assert.deepEqual([r.status, r.json.code], [403, "FORBIDDEN_ROLE"]);
    assert.equal(calls.length, 0);
  }));

test("route: viewers, planners (own sede) and admins (any sede) can read; wrapped in { data }", () =>
  withApp(async ({ call, calls }) => {
    for (const [token, sede] of [["t-viewer", "copacabana"], ["t-planner", "copacabana"], ["t-admin", "las-vegas"]]) {
      const r = await call(p(sede), token);
      assert.equal(r.status, 200, token);
      assert.deepEqual(r.json, { data: [{ weekStart: "2031-01-06" }] });
    }
    assert.equal(calls.length, 3);
  }));

test("route: a scoped user on another sede is 403 FORBIDDEN_SEDE", () =>
  withApp(async ({ call, calls }) => {
    for (const token of ["t-viewer", "t-planner"]) {
      const r = await call(p("las-vegas"), token);
      assert.deepEqual([r.status, r.json.code], [403, "FORBIDDEN_SEDE"], token);
    }
    assert.equal(calls.length, 0);
  }));

test("route: the service gets access, sede and the parsed query with defaults", () =>
  withApp(async ({ call, calls }) => {
    await call(p(), "t-viewer");
    await call(p("copacabana", "?status=BORRADOR&limit=5"), "t-planner");
    assert.deepEqual(calls[0], [{ role: "viewer", sedeIds: ["copacabana"] }, "copacabana", { status: "PUBLICADO", limit: 26 }]);
    assert.deepEqual(calls[1][2], { status: "BORRADOR", limit: 5 });
  }));

test("route: invalid status or limit is 400 VALIDATION_ERROR", () =>
  withApp(async ({ call, calls }) => {
    for (const qs of ["?status=ARCHIVADO", "?limit=0", "?limit=53", "?limit=x"]) {
      const r = await call(p("copacabana", qs), "t-viewer");
      assert.deepEqual([r.status, r.json.code], [400, "VALIDATION_ERROR"], qs);
    }
    assert.equal(calls.length, 0);
  }));

// ---------------------------------------------------------------------------
// Migration 009 (static)
// ---------------------------------------------------------------------------
const read = (rel) => readFileSync(new URL(`../../db/${rel}`, import.meta.url), "utf8");
const flat = (s) => s.toLowerCase().replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

test("migration 009: grouped distinct-cedula count, service_role only, with rollback and verify", () => {
  const sql = flat(read("migrations/009_shifts_people_counts.sql"));
  assert.match(sql, /create or replace function shifts_people_counts\(p_schedule_ids uuid\[\]\)/);
  assert.match(sql, /returns table \(schedule_id uuid, people int\)/);
  assert.ok(sql.includes("count(distinct s.cedula)"));
  assert.ok(sql.includes("group by"));
  assert.ok(sql.includes("revoke all on function shifts_people_counts(uuid[]) from public"));
  assert.ok(sql.includes("revoke all on function shifts_people_counts(uuid[]) from anon, authenticated"));
  assert.ok(sql.includes("grant execute on function shifts_people_counts(uuid[]) to service_role"));
  assert.ok(flat(read("migrations/rollback/009_shifts_people_counts.down.sql")).includes("drop function if exists shifts_people_counts(uuid[])"));
  const verify = flat(read("verification/009_shifts_people_counts_verify.sql")).trim();
  assert.match(verify, /^begin;/);
  assert.match(verify, /rollback;$/);
});
