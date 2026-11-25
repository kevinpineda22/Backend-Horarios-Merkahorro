import test from "node:test";
import assert from "node:assert/strict";
import { mapPrecontractuales, normalizeTypedCargo } from "../../src/modules/empleados/domain/precontractuales.js";
import { createEmpleadosService } from "../../src/modules/empleados/empleados.service.js";
import { createTrazabilidadClient } from "../../src/modules/empleados/trazabilidad.client.js";
import { listQuerySchema } from "../../src/modules/empleados/empleados.routes.js";

const ADMIN = { role: "admin", sedeIds: null };
const PLANNER = { role: "planner", sedeIds: ["villahermosa"] };
const pre = (cedula, extra = {}) => ({ cedula, nombre: "Valentina", cargo: "CAJERO SURTIDOR", sede: "Villa Hermosa", precontractual: true, ...extra });
const ACTIVE = [{ cedula: "111111", nombre: "Ana", cargo: "CAJERO (A)", sede: "Sede Villahermosa", activo: true }];
const ALIASES = new Map([["sede villahermosa", "villahermosa"]]);

function setup({ precontractuales = [pre("222222")], fail = false, legacy = false } = {}) {
  const marks = [];
  const client = { async fetchEmpleadosActivos() { return { data: ACTIVE, actualizado: "T" }; } };
  if (!legacy) client.fetchPrecontractuales = async () => { if (fail) throw new Error("404"); return { data: precontractuales }; };
  const exclusionsRepo = {
    async listActive() { return marks; },
    async create(m) { const r = { ...m, createdBy: m.userId }; marks.push(r); return r; },
    async revoke({ cedula }) { const i = marks.findIndex((m) => m.cedula === cedula); if (i >= 0) marks.splice(i, 1); return i >= 0; },
  };
  return createEmpleadosService({ client, aliasRepo: { async loadAliasMap() { return ALIASES; } }, exclusionsRepo, logger: null });
}

test("typed cargos are translated to the SIESA ones; look-alikes are not", () => {
  for (const c of ["CAJERO SURTIDOR", "Cajera/Surtidora", "cajero -surtidor", "CAJERA SURTIDDOR", "Cajero-surtidor", "cajera surtidora"]) assert.equal(normalizeTypedCargo(c), "CAJERO - SURTIDOR", c);
  for (const c of ["CAJERO", "cajera"]) assert.equal(normalizeTypedCargo(c), "CAJERO (A)");
  assert.equal(normalizeTypedCargo("Cajera/Pac"), "CAJERO PAC");
  for (const c of ["SURTIDOR", "JEFE DE CAJEROS", "surtidor,domiciliario", "CAJERO SURTIDOR JEFE"]) assert.equal(normalizeTypedCargo(c), c.toUpperCase());
  assert.equal(normalizeTypedCargo(null), "");
});

test("maps the form's sedes, skips active, repeated and unflagged people", () => {
  const rows = mapPrecontractuales(
    [pre("222222"), pre("0222222"), pre("111111"), pre("12"), { ...pre("333333"), precontractual: undefined }, pre("444444", { sede: "Sede Villahermosa" }), pre("555555", { sede: "Otra" })],
    ALIASES,
    new Set(["111111"]),
  );
  assert.deepEqual(rows.map((r) => [r.cedula, r.sedeId, r.cargo, r.precontractual]), [
    ["222222", "villahermosa", "CAJERO - SURTIDOR", true],
    ["444444", "villahermosa", "CAJERO - SURTIDOR", true],
    ["555555", null, "CAJERO - SURTIDOR", true],
  ]);
});

test("list hides them unless asked, keeps the sede scope and says when the source is down", async () => {
  const s = setup();
  assert.deepEqual((await s.list(ADMIN)).data.map((r) => r.cedula), ["111111"]);
  const all = await s.list(PLANNER, { precontractuales: true });
  assert.deepEqual(all.data.map((r) => r.cedula), ["111111", "222222"]);
  assert.equal(all.precontractualesDisponibles, true);
  assert.deepEqual((await s.list({ role: "planner", sedeIds: ["barbosa"] }, { precontractuales: true })).data, []);
  for (const broken of [setup({ fail: true }), setup({ legacy: true })]) {
    const res = await broken.list(ADMIN, { precontractuales: true });
    assert.deepEqual([res.data.length, res.precontractualesDisponibles], [1, false]);
  }
});

test("a pre-contractual cashier can be marked 'Programar en caja'; an active one still cannot", async () => {
  const s = setup();
  const out = await s.setInclusion(PLANNER, { id: "u" }, "222222", { incluido: true, motivo: null });
  assert.equal(out.incluidoEnCaja, true);
  assert.equal((await s.list(ADMIN, { precontractuales: true })).data.find((r) => r.cedula === "222222").incluidoEnCaja, true);
  await assert.rejects(s.setInclusion(PLANNER, { id: "u" }, "111111", { incluido: true, motivo: null }), { code: "CARGO_YA_ES_CAJA" });
  await assert.rejects(s.setInclusion({ role: "planner", sedeIds: ["barbosa"] }, { id: "u" }, "222222", { incluido: true, motivo: null }), { code: "FORBIDDEN_SEDE" });
});

test("the public lookup keeps answering for active people only", async () => {
  assert.equal(await setup().findActiveByCedula("222222"), null);
});

test("client and query: own path with the service key; only '1' asks for them", async () => {
  const urls = [];
  const client = createTrazabilidadClient({ baseUrl: "https://t.test/", serviceKey: "k", logger: null, fetchImpl: async (u, o) => { urls.push([u, o.headers["x-api-key"]]); return { ok: true, json: async () => ({ data: [] }) }; } });
  await client.fetchPrecontractuales();
  assert.deepEqual(urls, [["https://t.test/api/trazabilidad/service/empleados-precontractuales", "k"]]);
  assert.equal(listQuerySchema.parse({}).precontractuales, false);
  assert.equal(listQuerySchema.parse({ precontractuales: "1" }).precontractuales, true);
  assert.equal(listQuerySchema.safeParse({ precontractuales: "yes" }).success, false);
});

test("'Solo surtidor' is refused for somebody pre-contractual", async () => {
  await assert.rejects(setup().setExclusion(ADMIN, { id: "u" }, "222222", { excluido: true, motivo: null }), { code: "PRECONTRACTUAL", statusCode: 409 });
});

test("a blip of the source keeps the last known people, and is retried sooner", async () => {
  let now = 0;
  let down = false;
  let calls = 0;
  const client = {
    async fetchEmpleadosActivos() { return { data: ACTIVE, actualizado: "T" }; },
    async fetchPrecontractuales() { calls += 1; if (down) throw new Error("x"); return { data: [pre("222222")] }; },
  };
  const s = createEmpleadosService({ client, aliasRepo: { async loadAliasMap() { return ALIASES; } }, logger: null, now: () => now });
  await s.list(ADMIN, { precontractuales: true });
  down = true;
  now = 300001;
  const res = await s.list(ADMIN, { precontractuales: true });
  assert.deepEqual([res.data.length, res.precontractualesDisponibles], [2, false]);
  down = false;
  now += 60001;
  assert.equal((await s.list(ADMIN, { precontractuales: true })).precontractualesDisponibles, true);
  assert.equal(calls, 3);
});
