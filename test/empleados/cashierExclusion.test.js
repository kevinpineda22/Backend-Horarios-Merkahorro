import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createCashierExclusionsRepo } = await import("../../src/modules/empleados/cashierExclusions.supabase.js");
const { createEmpleadosRouter, exclusionBodySchema, exclusionParamsSchema } = await import("../../src/modules/empleados/empleados.routes.js");
const { createEmpleadosService } = await import("../../src/modules/empleados/empleados.service.js");
const { createStaffPort } = await import("../../src/modules/sugerido/repositories/staff.port.js");

const code = (status, c) => (e) => e.statusCode === status && e.code === c && e.expose === true;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
test("params: the cedula must have 5 to 15 digits once normalized (leading zeros allowed)", () => {
  assert.equal(exclusionParamsSchema.safeParse({ cedula: "00111111" }).success, true);
  for (const cedula of ["abc", "1234", "1".repeat(16), "", "12 34"]) {
    assert.equal(exclusionParamsSchema.safeParse({ cedula }).success, false, cedula);
  }
});

test("body: excluido is a mandatory boolean; motivo is trimmed, optional, nullable and at most 200 characters", () => {
  assert.deepEqual(exclusionBodySchema.parse({ excluido: true, motivo: "  Solo surtidor " }), { excluido: true, motivo: "Solo surtidor" });
  assert.equal(exclusionBodySchema.parse({ excluido: false }).motivo, null);
  assert.equal(exclusionBodySchema.parse({ excluido: true, motivo: null }).motivo, null);
  assert.equal(exclusionBodySchema.parse({ excluido: true, motivo: "   " }).motivo, null, "blank is no motivo");
  assert.equal(exclusionBodySchema.parse({ excluido: true, motivo: "x".repeat(200) }).motivo.length, 200);
  for (const body of [{}, { excluido: "true" }, { excluido: 1 }, { excluido: true, motivo: "x".repeat(201) }, { excluido: true, motivo: 5 }, null]) {
    assert.equal(exclusionBodySchema.safeParse(body).success, false, JSON.stringify(body));
  }
  assert.deepEqual(exclusionBodySchema.parse({ excluido: true, extra: 1 }), { excluido: true, motivo: null });
});

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------
function fakeClient(script = {}) {
  const log = [];
  const builder = (result) =>
    new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve(result).then(res, rej);
        return (...args) => (log.push([prop, ...args]), builder(result));
      },
    });
  const queue = (script.results ?? []).slice();
  return { log, client: { from: (t) => (log.push(["from", t]), builder(queue.length ? queue.shift() : { data: null, error: null })) } };
}
const has = (log, ...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));
const ROW = { id: "e1", cedula: "111111", sede_id: "s1", motivo: "Solo surtidor", created_by: "u-admin", created_at: "2026-11-10T10:00:00+00:00" };

test("repo.listActive: ONE query for the active rows only, mapped to camelCase", async () => {
  const { log, client } = fakeClient({ results: [{ data: [ROW], error: null }] });
  assert.deepEqual(await createCashierExclusionsRepo(client).listActive(), [
    { cedula: "111111", sedeId: "s1", motivo: "Solo surtidor", createdBy: "u-admin", createdAt: "2026-11-10T10:00:00.000Z" },
  ]);
  assert.equal(log.filter((c) => c[0] === "from").length, 1);
  assert.ok(has(log, "from", "cashier_exclusions"));
  assert.ok(has(log, "is", "revoked_at", null));
  assert.deepEqual(await createCashierExclusionsRepo(fakeClient({ results: [{ data: null, error: null }] }).client).listActive(), []);
  await assert.rejects(createCashierExclusionsRepo(fakeClient({ results: [{ data: null, error: new Error("down") }] }).client).listActive(), /down/);
});

test("repo.create inserts the active row and returns it; a concurrent duplicate (23505) returns the existing one", async () => {
  const ok = fakeClient({ results: [{ data: ROW, error: null }] });
  const out = await createCashierExclusionsRepo(ok.client).create({ cedula: "111111", sedeId: "s1", motivo: "Solo surtidor", userId: "u-admin" });
  assert.equal(out.cedula, "111111");
  assert.ok(has(ok.log, "insert", { cedula: "111111", sede_id: "s1", motivo: "Solo surtidor", created_by: "u-admin" }));

  const race = fakeClient({ results: [{ data: null, error: { code: "23505" } }, { data: ROW, error: null }] });
  assert.equal((await createCashierExclusionsRepo(race.client).create({ cedula: "111111", sedeId: "s1", motivo: null, userId: "u-admin" })).cedula, "111111");
  assert.ok(has(race.log, "is", "revoked_at", null));

  await assert.rejects(createCashierExclusionsRepo(fakeClient({ results: [{ data: null, error: new Error("boom") }] }).client).create({ cedula: "1", sedeId: null, motivo: null, userId: "u" }), /boom/);
});

test("repo.revoke soft-revokes only the ACTIVE row of that cedula, stamping who and when", async () => {
  const { log, client } = fakeClient({ results: [{ data: [{ id: "e1" }], error: null }] });
  const repo = createCashierExclusionsRepo(client, { now: () => new Date("2026-11-11T09:00:00Z") });
  assert.equal(await repo.revoke({ cedula: "111111", userId: "u-planner" }), true);
  assert.ok(has(log, "update", { revoked_by: "u-planner", revoked_at: "2026-11-11T09:00:00.000Z" }));
  assert.ok(has(log, "eq", "cedula", "111111"));
  assert.ok(has(log, "is", "revoked_at", null));
  assert.equal(await createCashierExclusionsRepo(fakeClient({ results: [{ data: [], error: null }] }).client).revoke({ cedula: "1", userId: "u" }), false);
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
const SOURCE = [
  { cedula: "111111", nombre: "Ana", cargo: "Cajero - Surtidor", sede: "Centro", activo: true },
  { cedula: "222222", nombre: "Luis", cargo: "Cajero", sede: "Norte", activo: true },
  { cedula: "333333", nombre: "Mara", cargo: "Cajera", sede: "Lejana", activo: true },
];
const ALIASES = new Map([["centro", "s1"], ["norte", "s2"]]);
const ADMIN = { role: "admin", sedeIds: null };
const PLANNER_S1 = { role: "planner", sedeIds: ["s1"] };
const PLANNER_ALL = { role: "planner", sedeIds: null };
const VIEWER = { role: "viewer", sedeIds: ["s1"] };
const NAMES = { "u-admin": "Ana Admin", "u-planner": "Paula Planner" };

function fakeExclusions(initial = []) {
  const state = { active: [...initial], calls: [] };
  return {
    state,
    async listActive() { state.calls.push(["listActive"]); return state.active.map((e) => ({ ...e })); },
    async create(args) {
      state.calls.push(["create", args]);
      const row = { cedula: args.cedula, sedeId: args.sedeId, motivo: args.motivo, createdBy: args.userId, createdAt: "2026-11-11T09:00:00.000Z" };
      state.active.push(row);
      return row;
    },
    async revoke(args) {
      state.calls.push(["revoke", args]);
      const before = state.active.length;
      state.active = state.active.filter((e) => e.cedula !== args.cedula);
      return state.active.length < before;
    },
  };
}
const EX1 = { cedula: "111111", sedeId: "s1", motivo: "Solo surtidor", createdBy: "u-admin", createdAt: "2026-11-10T10:00:00.000Z" };

function setup({ exclusions = [], rows = SOURCE } = {}) {
  const repo = fakeExclusions(exclusions);
  const profileCalls = [];
  const service = createEmpleadosService({
    client: { fetchEmpleadosActivos: async () => ({ data: rows, total: rows.length, actualizado: "2026-01-01T00:00:00.000Z" }) },
    aliasRepo: { loadAliasMap: async () => ALIASES },
    exclusionsRepo: repo,
    profilesRepo: { async findById(id) { profileCalls.push(id); return NAMES[id] ? { nombre: NAMES[id] } : null; } },
    logger: null,
  });
  return { service, repo, profileCalls };
}

test("list: every item carries excluidoDeCaja and exclusion { motivo, createdAt, createdByName } from ONE extra query", async () => {
  const { service, repo, profileCalls } = setup({ exclusions: [EX1] });
  const out = await service.list(ADMIN);
  const by = Object.fromEntries(out.data.map((r) => [r.cedula, r]));
  assert.deepEqual([by["111111"].excluidoDeCaja, by["111111"].exclusion], [true, { motivo: "Solo surtidor", createdAt: "2026-11-10T10:00:00.000Z", createdByName: "Ana Admin" }]);
  assert.deepEqual([by["222222"].excluidoDeCaja, by["222222"].exclusion], [false, null]);
  assert.equal(repo.state.calls.filter((c) => c[0] === "listActive").length, 1);
  assert.deepEqual(profileCalls, ["u-admin"]);
});

test("list: the cached directory is not mutated, and later changes show up immediately", async () => {
  const { service } = setup({ exclusions: [] });
  assert.equal((await service.list(ADMIN)).data[0].excluidoDeCaja, false);
  await service.setExclusion(ADMIN, { id: "u-admin" }, "111111", { excluido: true, motivo: null });
  assert.equal((await service.list(ADMIN)).data.find((r) => r.cedula === "111111").excluidoDeCaja, true);
});

test("list: an unknown creator name is null, and without exclusions no profile is read", async () => {
  const unknown = setup({ exclusions: [{ ...EX1, createdBy: "u-ghost" }] });
  assert.equal((await unknown.service.list(ADMIN)).data[0].exclusion.createdByName, null);
  const none = setup();
  await none.service.list(ADMIN);
  assert.deepEqual(none.profileCalls, []);
});

test("setExclusion: admin excludes an employee of any sede; the sede of the employee is recorded; answer shape", async () => {
  const { service, repo } = setup();
  const out = await service.setExclusion(ADMIN, { id: "u-admin" }, "222222", { excluido: true, motivo: "Solo surtidor" });
  assert.deepEqual(out, {
    cedula: "222222",
    excluidoDeCaja: true,
    exclusion: { motivo: "Solo surtidor", createdAt: "2026-11-11T09:00:00.000Z", createdByName: "Ana Admin" },
  });
  assert.deepEqual(repo.state.calls.find((c) => c[0] === "create")[1], { cedula: "222222", sedeId: "s2", motivo: "Solo surtidor", userId: "u-admin" });
});

test("setExclusion: a cedula with leading zeros is normalized", async () => {
  const { service, repo } = setup();
  assert.equal((await service.setExclusion(ADMIN, { id: "u-admin" }, "0111111", { excluido: true, motivo: null })).cedula, "111111");
  assert.equal(repo.state.calls.find((c) => c[0] === "create")[1].cedula, "111111");
});

test("setExclusion: idempotent both ways - repeating the same state is a 200 no-op that writes nothing", async () => {
  const { service, repo } = setup({ exclusions: [EX1] });
  const again = await service.setExclusion(ADMIN, { id: "u-admin" }, "111111", { excluido: true, motivo: "otro motivo" });
  assert.equal(again.excluidoDeCaja, true);
  assert.equal(again.exclusion.motivo, "Solo surtidor", "the existing exclusion is kept untouched");
  assert.equal(repo.state.calls.some((c) => c[0] === "create"), false);

  const off = await service.setExclusion(ADMIN, { id: "u-admin" }, "111111", { excluido: false, motivo: null });
  assert.deepEqual(off, { cedula: "111111", excluidoDeCaja: false, exclusion: null });
  const offAgain = await service.setExclusion(ADMIN, { id: "u-admin" }, "111111", { excluido: false, motivo: null });
  assert.deepEqual(offAgain, { cedula: "111111", excluidoDeCaja: false, exclusion: null });
  assert.deepEqual(repo.state.calls.filter((c) => c[0] === "revoke").map((c) => c[1]), [{ cedula: "111111", userId: "u-admin" }, { cedula: "111111", userId: "u-admin" }]);
});

test("setExclusion auth matrix: admin anywhere; planner only in their sedes; viewer never", async () => {
  const ctx = (a, cedula) => setup().service.setExclusion(a, { id: "u" }, cedula, { excluido: true, motivo: null });
  assert.equal((await ctx(ADMIN, "333333")).excluidoDeCaja, true, "admin on an unmapped sede");
  assert.equal((await ctx(PLANNER_S1, "111111")).excluidoDeCaja, true, "planner in their sede");
  assert.equal((await ctx(PLANNER_ALL, "222222")).excluidoDeCaja, true, "unscoped planner");
  await assert.rejects(ctx(PLANNER_S1, "222222"), code(403, "FORBIDDEN_SEDE"));
  await assert.rejects(ctx(PLANNER_S1, "333333"), code(403, "FORBIDDEN_SEDE"));
  await assert.rejects(ctx(VIEWER, "111111"), code(403, "FORBIDDEN_ROLE"));
});

test("setExclusion: a forbidden caller changes nothing; an unknown or non-active cedula is 404 EMPLEADO_NOT_FOUND", async () => {
  const { service, repo } = setup();
  await assert.rejects(service.setExclusion(PLANNER_S1, { id: "u" }, "222222", { excluido: true, motivo: null }), code(403, "FORBIDDEN_SEDE"));
  await assert.rejects(service.setExclusion(ADMIN, { id: "u" }, "999999", { excluido: true, motivo: null }), code(404, "EMPLEADO_NOT_FOUND"));
  await assert.rejects(service.setExclusion(ADMIN, { id: "u" }, "444444", { excluido: false, motivo: null }), code(404, "EMPLEADO_NOT_FOUND"));
  assert.equal(repo.state.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Cashier pool (sugerido)
// ---------------------------------------------------------------------------
test("staff port: an excluded cashier is not in the pool; reverting brings her back", async () => {
  const { service } = setup({ exclusions: [EX1] });
  const port = createStaffPort(service, { getSede: async () => ({}) });
  assert.deepEqual(await port.getCashierPool("s1"), []);
  await service.setExclusion(ADMIN, { id: "u-admin" }, "111111", { excluido: false, motivo: null });
  assert.deepEqual(await port.getCashierPool("s1"), [{ cedula: "111111" }]);
});

test("staff port: only the excluded person leaves the pool of her sede", async () => {
  const rows = [
    { cedula: "111111", nombre: "Ana", cargo: "Cajero - Surtidor", sede: "Centro", activo: true },
    { cedula: "555555", nombre: "Eva", cargo: "Cajera", sede: "Centro", activo: true },
  ];
  const { service } = setup({ exclusions: [EX1], rows });
  const port = createStaffPort(service, { getSede: async () => ({}) });
  assert.deepEqual(await port.getCashierPool("s1"), [{ cedula: "555555" }]);
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
const TOKENS = { "t-admin": "u-admin", "t-planner": "u-planner", "t-viewer": "u-viewer", "t-stranger": "u-none" };
const ACCESS = {
  "u-admin": { role: "admin", sede_ids: null },
  "u-planner": { role: "planner", sede_ids: ["s1"] },
  "u-viewer": { role: "viewer", sede_ids: ["s1"] },
};

async function withApp(fn, setupOpts) {
  const { service, repo } = setup(setupOpts);
  const router = createEmpleadosRouter({
    authenticate: createAuthenticate({ verifyToken: async (t) => (TOKENS[t] ? { id: TOKENS[t], email: "x@x.co" } : null) }),
    accessRepo: { findByUserId: async (id) => ACCESS[id] ?? null },
    service,
  });
  const server = createApp({ routes: createRoutes({ modules: { "/empleados": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/empleados`;
  const call = async (method, path, token, json) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ call, repo });
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const put = (cedula = "111111") => `/${cedula}/exclusion-caja`;

test("route PUT: 401 without a token, 403 without access row and for viewers (even with an invalid body)", () =>
  withApp(async ({ call, repo }) => {
    assert.equal((await call("PUT", put(), null, { excluido: true })).status, 401);
    assert.equal((await call("PUT", put(), "t-stranger", { excluido: true })).status, 403);
    const v = await call("PUT", put(), "t-viewer", {});
    assert.deepEqual([v.status, v.json.code], [403, "FORBIDDEN_ROLE"]);
    assert.equal(repo.state.calls.length, 0);
  }));

test("route PUT: admin and planner (own sede) get 200 { data: { cedula, excluidoDeCaja, exclusion } }", () =>
  withApp(async ({ call }) => {
    const a = await call("PUT", put("222222"), "t-admin", { excluido: true, motivo: "Solo surtidor" });
    assert.equal(a.status, 200);
    assert.deepEqual(Object.keys(a.json), ["data"]);
    assert.deepEqual(a.json.data, {
      cedula: "222222", excluidoDeCaja: true,
      exclusion: { motivo: "Solo surtidor", createdAt: "2026-11-11T09:00:00.000Z", createdByName: "Ana Admin" },
    });
    const p = await call("PUT", put("111111"), "t-planner", { excluido: true });
    assert.equal(p.status, 200);
    assert.equal(p.json.data.exclusion.createdByName, "Paula Planner");
    const off = await call("PUT", put("111111"), "t-planner", { excluido: false });
    assert.deepEqual(off.json.data, { cedula: "111111", excluidoDeCaja: false, exclusion: null });
  }));

test("route PUT: a planner on another sede is 403 FORBIDDEN_SEDE; an unknown cedula is 404 EMPLEADO_NOT_FOUND", () =>
  withApp(async ({ call, repo }) => {
    const s = await call("PUT", put("222222"), "t-planner", { excluido: true });
    assert.deepEqual([s.status, s.json.code], [403, "FORBIDDEN_SEDE"]);
    const n = await call("PUT", put("999999"), "t-admin", { excluido: true });
    assert.deepEqual([n.status, n.json.code], [404, "EMPLEADO_NOT_FOUND"]);
    assert.equal(repo.state.calls.length, 0);
  }));

test("route PUT: invalid cedula or body is 400 VALIDATION_ERROR", () =>
  withApp(async ({ call, repo }) => {
    for (const [path, body] of [[put("abc"), { excluido: true }], [put("12"), { excluido: true }], [put(), {}], [put(), { excluido: "yes" }], [put(), { excluido: true, motivo: "x".repeat(201) }]]) {
      const r = await call("PUT", path, "t-admin", body);
      assert.deepEqual([r.status, r.json.code], [400, "VALIDATION_ERROR"], JSON.stringify([path, body]));
    }
    assert.equal(repo.state.calls.length, 0);
  }));

test("route GET: every employee has excluidoDeCaja and exclusion", () =>
  withApp(async ({ call }) => {
    const r = await call("GET", "", "t-admin");
    assert.equal(r.status, 200);
    const ana = r.json.data.find((e) => e.cedula === "111111");
    assert.deepEqual([ana.excluidoDeCaja, ana.exclusion.motivo, ana.exclusion.createdByName], [true, "Solo surtidor", "Ana Admin"]);
    assert.deepEqual(r.json.data.find((e) => e.cedula === "222222").exclusion, null);
  }, { exclusions: [EX1] }));

// ---------------------------------------------------------------------------
// Migration 011 (static)
// ---------------------------------------------------------------------------
const read = (rel) => readFileSync(new URL(`../../db/${rel}`, import.meta.url), "utf8");
const flat = (s) => s.toLowerCase().replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
const sql = flat(read("migrations/011_cashier_exclusions.sql"));

test("migration 011: table with soft revoke, one ACTIVE row per cedula, validated columns", () => {
  assert.ok(sql.includes("create table if not exists cashier_exclusions ("));
  assert.ok(sql.includes("cedula text not null check (cedula ~ '^[0-9]{5,15}$')"));
  assert.ok(sql.includes("motivo text check (motivo is null or char_length(motivo) <= 200)"));
  assert.ok(sql.includes("created_by uuid not null"));
  assert.ok(sql.includes("revoked_by uuid") && sql.includes("revoked_at timestamptz"));
  assert.ok(sql.includes("check ((revoked_at is null) = (revoked_by is null))"));
  assert.ok(sql.includes("create unique index if not exists cashier_exclusions_active_cedula_idx on cashier_exclusions (cedula) where revoked_at is null"));
});

test("migration 011: RLS on, closed to anon/authenticated, no policies; header says apply before deploy", () => {
  assert.ok(sql.includes("alter table cashier_exclusions enable row level security"));
  assert.ok(sql.includes("revoke all on table cashier_exclusions from anon, authenticated"));
  assert.doesNotMatch(sql, /create policy/);
  assert.match(read("migrations/011_cashier_exclusions.sql"), /apply this BEFORE deploying the backend/i);
});

test("migration 011: rollback snapshots then drops; verify ends in ROLLBACK", () => {
  const d = flat(read("migrations/rollback/011_cashier_exclusions.down.sql"));
  assert.ok(d.indexOf("cashier_exclusions_backup_011") < d.indexOf("drop table if exists cashier_exclusions;"));
  assert.ok(d.includes("table_schema = 'public'"));
  const v = flat(read("verification/011_cashier_exclusions_verify.sql")).trim();
  assert.match(v, /^begin;/);
  assert.match(v, /rollback;$/);
  assert.ok(v.includes("all checks passed"));
});

test("computeRun: the cashiers available to the recommendation drop the excluded ones", async () => {
  const { makeDeps, USER, WEEK } = await import("../sugerido/api.helpers.js");
  const { createSugeridoService } = await import("../../src/modules/sugerido/sugerido.service.js");
  const rows = ["111111", "555555", "666666"].map((cedula) => ({ cedula, nombre: cedula, cargo: "Cajera", sede: "Centro", activo: true }));
  const { service: empleados } = setup({ exclusions: [EX1], rows });
  const ctx = makeDeps();
  ctx.deps.staffPort = createStaffPort(empleados, ctx.repo);
  const view = await createSugeridoService(ctx.deps).computeRun(USER, "s1", WEEK);
  assert.equal(view.inputs.poolSize, 2, "3 cashiers in SIESA, 1 marked solo surtidor");
});
