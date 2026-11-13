import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createCashierExclusionsRepo } = await import("../../src/modules/empleados/cashierExclusions.supabase.js");
const { createEmpleadosRouter, inclusionBodySchema } = await import("../../src/modules/empleados/empleados.routes.js");
const { createEmpleadosService } = await import("../../src/modules/empleados/empleados.service.js");
const { createStaffPort } = await import("../../src/modules/sugerido/repositories/staff.port.js");

// "Programar en caja" (migration 012): the opposite mark of "Solo surtidor". It puts somebody whose SIESA cargo is not a
// cashier one (CAJERO PAC, Auxiliar de Fruver...) in the cashier pool. A person has at most ONE active mark.

const code = (status, c) => (e) => e.statusCode === status && e.code === c && e.expose === true;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
test("body: incluido is a mandatory boolean; motivo is trimmed, optional and at most 200 characters", () => {
  assert.deepEqual(inclusionBodySchema.parse({ incluido: true, motivo: "  Cajera PAC confirmada " }), { incluido: true, motivo: "Cajera PAC confirmada" });
  assert.equal(inclusionBodySchema.parse({ incluido: false }).motivo, null);
  for (const body of [{}, { incluido: "true" }, { incluido: true, motivo: "x".repeat(201) }, null]) {
    assert.equal(inclusionBodySchema.safeParse(body).success, false, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------
function fakeClient(results = []) {
  const log = [];
  const builder = (result) =>
    new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve(result).then(res, rej);
        return (...args) => (log.push([prop, ...args]), builder(result));
      },
    });
  const queue = results.slice();
  return { log, client: { from: (t) => (log.push(["from", t]), builder(queue.length ? queue.shift() : { data: null, error: null })) } };
}
const has = (log, ...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));

test("repo: rows carry their kind (a row without one, written before 012, is an exclusion)", async () => {
  const rows = [
    { cedula: "111111", sede_id: "s1", motivo: null, created_by: "u", created_at: "2026-11-10T10:00:00Z", kind: "include" },
    { cedula: "222222", sede_id: "s1", motivo: null, created_by: "u", created_at: "2026-11-10T10:00:00Z" },
  ];
  const { client } = fakeClient([{ data: rows, error: null }]);
  assert.deepEqual((await createCashierExclusionsRepo(client).listActive()).map((r) => r.kind), ["include", "exclude"]);
});

test("repo.create writes the kind; repo.revoke can be limited to one kind", async () => {
  const created = fakeClient([{ data: { cedula: "111111", kind: "include", created_by: "u" }, error: null }]);
  const out = await createCashierExclusionsRepo(created.client).create({ cedula: "111111", sedeId: "s1", motivo: "PAC", userId: "u", kind: "include" });
  assert.equal(out.kind, "include");
  assert.ok(has(created.log, "insert", { cedula: "111111", sede_id: "s1", motivo: "PAC", created_by: "u", kind: "include" }));

  const revoked = fakeClient([{ data: [{ id: "x" }], error: null }]);
  await createCashierExclusionsRepo(revoked.client).revoke({ cedula: "111111", userId: "u", kind: "include" });
  assert.ok(has(revoked.log, "eq", "kind", "include"));
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
const SOURCE = [
  { cedula: "111111", nombre: "Catalina", cargo: "CAJERO PAC", sede: "Centro", activo: true },
  { cedula: "222222", nombre: "Luis", cargo: "Cajero", sede: "Centro", activo: true },
  { cedula: "333333", nombre: "Mara", cargo: "Auxiliar de Fruver", sede: "Norte", activo: true },
];
const ALIASES = new Map([["centro", "s1"], ["norte", "s2"]]);
const ADMIN = { role: "admin", sedeIds: null };
const PLANNER_S1 = { role: "planner", sedeIds: ["s1"] };
const VIEWER = { role: "viewer", sedeIds: ["s1"] };

function fakeMarks(initial = []) {
  const state = { active: [...initial], calls: [] };
  return {
    state,
    async listActive() { state.calls.push(["listActive"]); return state.active.map((e) => ({ ...e })); },
    async create(args) {
      state.calls.push(["create", args]);
      const row = { cedula: args.cedula, sedeId: args.sedeId, motivo: args.motivo, createdBy: args.userId, createdAt: "2026-11-13T09:00:00.000Z", kind: args.kind ?? "exclude" };
      state.active.push(row);
      return row;
    },
    async revoke(args) {
      state.calls.push(["revoke", args]);
      const before = state.active.length;
      state.active = state.active.filter((e) => !(e.cedula === args.cedula && (!args.kind || e.kind === args.kind)));
      return state.active.length < before;
    },
  };
}
const INC1 = { cedula: "111111", sedeId: "s1", motivo: "Cajera PAC", createdBy: "u-admin", createdAt: "2026-11-12T10:00:00.000Z", kind: "include" };
const EXC2 = { cedula: "222222", sedeId: "s1", motivo: "Solo surtidor", createdBy: "u-admin", createdAt: "2026-11-12T10:00:00.000Z", kind: "exclude" };

function setup({ marks = [], rows = SOURCE } = {}) {
  const repo = fakeMarks(marks);
  const service = createEmpleadosService({
    client: { fetchEmpleadosActivos: async () => ({ data: rows, total: rows.length, actualizado: "2026-01-01T00:00:00.000Z" }) },
    aliasRepo: { loadAliasMap: async () => ALIASES },
    exclusionsRepo: repo,
    profilesRepo: { async findById(id) { return id === "u-admin" ? { nombre: "Ana Admin" } : null; } },
    logger: null,
  });
  return { service, repo };
}

test("list: an include mark shows as incluidoEnCaja + inclusion, never as an exclusion", async () => {
  const { service } = setup({ marks: [INC1, EXC2] });
  const by = Object.fromEntries((await service.list(ADMIN)).data.map((r) => [r.cedula, r]));
  assert.deepEqual(
    [by["111111"].incluidoEnCaja, by["111111"].inclusion, by["111111"].excluidoDeCaja, by["111111"].exclusion],
    [true, { motivo: "Cajera PAC", createdAt: "2026-11-12T10:00:00.000Z", createdByName: "Ana Admin" }, false, null],
  );
  assert.deepEqual([by["222222"].excluidoDeCaja, by["222222"].incluidoEnCaja, by["222222"].inclusion], [true, false, null]);
  assert.deepEqual([by["333333"].excluidoDeCaja, by["333333"].incluidoEnCaja], [false, false]);
});

test("setInclusion: includes, records the sede, and is idempotent both ways", async () => {
  const { service, repo } = setup();
  const on = await service.setInclusion(ADMIN, { id: "u-admin" }, "111111", { incluido: true, motivo: "Cajera PAC" });
  assert.deepEqual(on, { cedula: "111111", incluidoEnCaja: true, inclusion: { motivo: "Cajera PAC", createdAt: "2026-11-13T09:00:00.000Z", createdByName: "Ana Admin" } });
  assert.deepEqual(repo.state.calls.find((c) => c[0] === "create")[1], { cedula: "111111", sedeId: "s1", motivo: "Cajera PAC", userId: "u-admin", kind: "include" });
  await service.setInclusion(ADMIN, { id: "u-admin" }, "111111", { incluido: true, motivo: "otro" });
  assert.equal(repo.state.calls.filter((c) => c[0] === "create").length, 1, "the same state again writes nothing");

  assert.deepEqual(await service.setInclusion(ADMIN, { id: "u-admin" }, "111111", { incluido: false, motivo: null }), { cedula: "111111", incluidoEnCaja: false, inclusion: null });
  assert.equal(repo.state.active.length, 0);
});

test("the two marks replace each other: including an excluded person lifts the exclusion, and the other way round", async () => {
  const { service, repo } = setup({ marks: [{ ...EXC2, cedula: "111111" }] });
  await service.setInclusion(ADMIN, { id: "u-admin" }, "111111", { incluido: true, motivo: null });
  assert.deepEqual(repo.state.active.map((m) => [m.cedula, m.kind]), [["111111", "include"]]);
  await service.setExclusion(ADMIN, { id: "u-admin" }, "111111", { excluido: true, motivo: "Solo surtidor" });
  assert.deepEqual(repo.state.active.map((m) => [m.cedula, m.kind]), [["111111", "exclude"]]);
});

test("unmarking one kind never lifts the other one", async () => {
  const { service, repo } = setup({ marks: [INC1, EXC2] });
  await service.setExclusion(ADMIN, { id: "u-admin" }, "111111", { excluido: false, motivo: null });
  await service.setInclusion(ADMIN, { id: "u-admin" }, "222222", { incluido: false, motivo: null });
  assert.deepEqual(repo.state.active.map((m) => [m.cedula, m.kind]).sort(), [["111111", "include"], ["222222", "exclude"]]);
});

test("setInclusion auth: admin anywhere, planner only in their sedes, viewer never; unknown cedula is 404", async () => {
  const call = (access, cedula) => setup().service.setInclusion(access, { id: "u" }, cedula, { incluido: true, motivo: null });
  assert.equal((await call(PLANNER_S1, "111111")).incluidoEnCaja, true);
  assert.equal((await call(ADMIN, "333333")).incluidoEnCaja, true);
  await assert.rejects(call(PLANNER_S1, "333333"), code(403, "FORBIDDEN_SEDE"));
  await assert.rejects(call(VIEWER, "111111"), code(403, "FORBIDDEN_ROLE"));
  await assert.rejects(call(ADMIN, "999999"), code(404, "EMPLEADO_NOT_FOUND"));
});

test("setInclusion: a cashier cargo is rejected with 409 CARGO_YA_ES_CAJA and nothing is written", async () => {
  const { service, repo } = setup();
  await assert.rejects(service.setInclusion(ADMIN, { id: "u-admin" }, "222222", { incluido: true, motivo: null }), code(409, "CARGO_YA_ES_CAJA"));
  assert.equal(repo.state.calls.some((c) => c[0] === "create" || c[0] === "revoke"), false);
  assert.deepEqual(await service.setInclusion(ADMIN, { id: "u-admin" }, "222222", { incluido: false, motivo: null }), { cedula: "222222", incluidoEnCaja: false, inclusion: null }, "unmarking stays allowed");
});

test("switching marks: if the new mark cannot be written, the lifted one is put back", async () => {
  const exc = { ...EXC2, cedula: "111111" };
  const { service, repo } = setup({ marks: [exc] });
  const create = repo.create;
  let first = true;
  repo.create = async (args) => {
    if (first) { first = false; throw new Error("insert failed"); }
    return create(args);
  };
  await assert.rejects(service.setInclusion(ADMIN, { id: "u-admin" }, "111111", { incluido: true, motivo: null }), /insert failed/);
  assert.deepEqual(repo.state.active.map((m) => [m.cedula, m.kind, m.motivo]), [["111111", "exclude", "Solo surtidor"]]);
});

test("switching marks: a concurrent change that wins the race is a 409 MARK_CONFLICT, never the wrong mark", async () => {
  const { service, repo } = setup();
  repo.create = async (args) => ({ cedula: args.cedula, sedeId: null, motivo: null, createdBy: "u-other", createdAt: "2026-11-13T09:00:00.000Z", kind: "exclude" });
  await assert.rejects(service.setInclusion(ADMIN, { id: "u-admin" }, "111111", { incluido: true, motivo: null }), code(409, "MARK_CONFLICT"));
});

// ---------------------------------------------------------------------------
// Cashier pool (sugerido)
// ---------------------------------------------------------------------------
test("staff port: an included person joins the pool whatever her cargo; lifting the mark takes her out", async () => {
  const { service } = setup({ marks: [INC1] });
  const port = createStaffPort(service, { getSede: async () => ({}) });
  assert.deepEqual((await port.getCashierPool("s1")).map((p) => p.cedula).sort(), ["111111", "222222"]);
  await service.setInclusion(ADMIN, { id: "u-admin" }, "111111", { incluido: false, motivo: null });
  assert.deepEqual(await port.getCashierPool("s1"), [{ cedula: "222222" }]);
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
const TOKENS = { "t-admin": "u-admin", "t-viewer": "u-viewer" };
const ACCESS = { "u-admin": { role: "admin", sede_ids: null }, "u-viewer": { role: "viewer", sede_ids: ["s1"] } };

test("route PUT /:cedula/inclusion-caja: 200 for admin, 403 for viewer, 400 for a bad body", async () => {
  const { service, repo } = setup();
  const router = createEmpleadosRouter({
    authenticate: createAuthenticate({ verifyToken: async (t) => (TOKENS[t] ? { id: TOKENS[t], email: "x@x.co" } : null) }),
    accessRepo: { findByUserId: async (id) => ACCESS[id] ?? null },
    service,
  });
  const server = createApp({ routes: createRoutes({ modules: { "/empleados": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/empleados`;
  const put = async (token, body) => {
    const res = await fetch(`${base}/111111/inclusion-caja`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    const ok = await put("t-admin", { incluido: true, motivo: "Cajera PAC" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.data, { cedula: "111111", incluidoEnCaja: true, inclusion: { motivo: "Cajera PAC", createdAt: "2026-11-13T09:00:00.000Z", createdByName: "Ana Admin" } });
    assert.equal((await put("t-viewer", { incluido: true })).status, 403);
    assert.equal((await put("t-admin", { incluido: "si" })).status, 400);
    assert.equal(repo.state.calls.filter((c) => c[0] === "create").length, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// Migration 012 (static)
// ---------------------------------------------------------------------------
const read = (rel) => readFileSync(new URL(`../../db/${rel}`, import.meta.url), "utf8");
const flat = (s) => s.toLowerCase().replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

test("migration 012: adds kind with default 'exclude' and a check, idempotent; header says apply before deploy", () => {
  const sql = flat(read("migrations/012_cashier_inclusions.sql"));
  assert.ok(sql.includes("alter table cashier_exclusions add column if not exists kind text not null default 'exclude'"));
  assert.ok(sql.includes("check (kind in ('exclude', 'include'))"));
  assert.ok(sql.includes("cashier_exclusions_kind_chk"));
  assert.match(read("migrations/012_cashier_inclusions.sql"), /apply this BEFORE deploying the backend/i);
});

test("migration 012: rollback snapshots the include rows before dropping the column; verify ends in ROLLBACK", () => {
  const d = flat(read("migrations/rollback/012_cashier_inclusions.down.sql"));
  assert.ok(d.indexOf("cashier_inclusions_backup_012") < d.indexOf("drop column if exists kind"));
  const v = flat(read("verification/012_cashier_inclusions_verify.sql")).trim();
  assert.match(v, /^begin;/);
  assert.match(v, /rollback;$/);
  assert.ok(v.includes("all checks passed"));
});
