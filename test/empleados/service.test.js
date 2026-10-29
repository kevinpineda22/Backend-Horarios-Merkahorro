import test from "node:test";
import assert from "node:assert/strict";
import { createEmpleadosService } from "../../src/modules/empleados/empleados.service.js";
import { createSedeAliasRepo } from "../../src/modules/empleados/sedeAliases.supabase.js";
import { createHttpError } from "../../src/shared/http/HttpError.js";

const ROWS = [
  { cedula: "00111111", nombre: "Ana Pérez", cargo: "Cajera", sede: "Centro", activo: true, restriccionOperativa: "No cargar" },
  { cedula: "222222", nombre: "Luis Gómez", cargo: "Auxiliar de Bodega", sede: "NORTE ", activo: true, restriccionOperativa: "" },
  { cedula: "333333", nombre: "María Rojas", cargo: "CAJERA", sede: "Lejana", activo: true },
  { cedula: "444444", nombre: "Inactivo", cargo: "Cajera", sede: "Centro", activo: false },
];
const ALIASES = new Map([["centro", "s1"], ["norte", "s2"]]);
const ADMIN = { role: "admin", sedeIds: null };
const PLANNER_ALL = { role: "planner", sedeIds: null };
const VIEWER_S1 = { role: "viewer", sedeIds: ["s1"] };
const ced = (res) => res.data.map((r) => r.cedula);

function setup({ ttlMs = 1000, rows = ROWS } = {}) {
  const state = { now: 0, fetches: 0, aliasLoads: 0, fail: false, gate: null, logs: [] };
  const client = {
    async fetchEmpleadosActivos() {
      state.fetches += 1;
      if (state.gate) await state.gate;
      if (state.fail) throw createHttpError(503, "down", "STAFF_SOURCE_UNAVAILABLE");
      return { data: rows, total: rows.length, actualizado: "2026-01-01T00:00:00.000Z" };
    },
  };
  const aliasRepo = {
    async loadAliasMap() {
      state.aliasLoads += 1;
      return ALIASES;
    },
  };
  const logger = { info: (...a) => state.logs.push(a), warn: (...a) => state.logs.push(a) };
  const service = createEmpleadosService({ client, aliasRepo, ttlMs, now: () => state.now, logger });
  return { service, state };
}

test("maps rows, dedupes cedula and returns total/actualizado", async () => {
  const { service } = setup();
  const res = await service.list(ADMIN);
  assert.equal(res.total, 3);
  assert.equal(res.actualizado, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(res.data.map((r) => [r.cedula, r.sedeId, r.unmappedSede]), [
    ["111111", "s1", false],
    ["222222", "s2", false],
    ["333333", null, true],
  ]);
  assert.equal(res.data[0].restriccionOperativa, "No cargar");
});

test("cache: second call does not hit source; expires exactly at TTL", async () => {
  const { service, state } = setup({ ttlMs: 1000 });
  await service.list(ADMIN);
  state.now = 999;
  await service.list(VIEWER_S1);
  assert.equal(state.fetches, 1);
  assert.equal(state.aliasLoads, 1);
  state.now = 1000;
  await service.list(ADMIN);
  assert.equal(state.fetches, 2);
});

test("ttlMs 0 disables caching", async () => {
  const { service, state } = setup({ ttlMs: 0 });
  await service.list(ADMIN);
  await service.list(ADMIN);
  assert.equal(state.fetches, 2);
});

test("ttlMs 0 disables caching even when the clock does not move", async () => {
  const { service, state } = setup({ ttlMs: 0 });
  state.now = 5;
  await service.list(ADMIN);
  await service.list(ADMIN);
  assert.equal(state.fetches, 2);
});

test("callers cannot corrupt the cached directory", async () => {
  const { service } = setup();
  const first = await service.list(ADMIN);
  assert.throws(() => first.data.push({ cedula: "999999" }), TypeError);
  assert.throws(() => {
    first.data[0].nombre = "HACK";
  }, TypeError);
  const again = await service.list(VIEWER_S1);
  assert.equal(again.data[0].nombre, "Ana Pérez");
  assert.equal((await service.list(ADMIN)).total, 3);
});

test("default TTL is 5 minutes", async () => {
  const state = { now: 0, fetches: 0 };
  const service = createEmpleadosService({
    client: { fetchEmpleadosActivos: async () => (state.fetches++, { data: ROWS }) },
    aliasRepo: { loadAliasMap: async () => ALIASES },
    now: () => state.now,
  });
  await service.list(ADMIN);
  state.now = 299999;
  await service.list(ADMIN);
  assert.equal(state.fetches, 1);
  state.now = 300000;
  await service.list(ADMIN);
  assert.equal(state.fetches, 2);
});

test("cache holds the mapped result: per-caller filtering happens after it", async () => {
  const { service, state } = setup();
  const admin = await service.list(ADMIN);
  const viewer = await service.list(VIEWER_S1);
  assert.equal(admin.data.length, 3);
  assert.deepEqual(ced(viewer), ["111111"]);
  assert.equal(viewer.total, 1);
  assert.equal((await service.list(ADMIN)).data.length, 3);
  assert.equal(state.fetches, 1);
});

test("unmapped rows visible to admin and all-sede callers, never to scoped callers", async () => {
  const { service } = setup();
  assert.ok((await service.list(PLANNER_ALL)).data.some((r) => r.unmappedSede));
  assert.ok(!(await service.list(VIEWER_S1)).data.some((r) => r.unmappedSede));
});

test("source failure -> 503 and is not cached (next call retries and succeeds)", async () => {
  const { service, state } = setup();
  state.fail = true;
  await assert.rejects(service.list(ADMIN), { statusCode: 503, code: "STAFF_SOURCE_UNAVAILABLE" });
  await assert.rejects(service.list(ADMIN), { statusCode: 503 });
  assert.equal(state.fetches, 2);
  state.fail = false;
  assert.equal((await service.list(ADMIN)).data.length, 3);
});

test("failed refresh after expiry does not serve stale data nor poison the cache", async () => {
  const { service, state } = setup({ ttlMs: 1000 });
  await service.list(ADMIN);
  state.now = 5000;
  state.fail = true;
  await assert.rejects(service.list(ADMIN), { statusCode: 503 });
  state.fail = false;
  assert.equal((await service.list(ADMIN)).data.length, 3);
  assert.equal(state.fetches, 3);
});

test("non-HttpError source failure is mapped to 503, never []", async () => {
  const service = createEmpleadosService({
    client: {
      fetchEmpleadosActivos: async () => {
        throw new Error("boom");
      },
    },
    aliasRepo: { loadAliasMap: async () => ALIASES },
  });
  await assert.rejects(service.list(ADMIN), { statusCode: 503, code: "STAFF_SOURCE_UNAVAILABLE" });
});

test("alias lookup failure -> 503 (rows would be wrongly unmapped)", async () => {
  const service = createEmpleadosService({
    client: { fetchEmpleadosActivos: async () => ({ data: ROWS }) },
    aliasRepo: {
      loadAliasMap: async () => {
        throw new Error("db");
      },
    },
  });
  await assert.rejects(service.list(ADMIN), { statusCode: 503, code: "STAFF_SOURCE_UNAVAILABLE" });
});

test("single-flight: concurrent cold requests share one load", async () => {
  const { service, state } = setup();
  let release;
  state.gate = new Promise((r) => (release = r));
  const calls = [service.list(ADMIN), service.list(VIEWER_S1), service.list(PLANNER_ALL)];
  release();
  const [a, b] = await Promise.all(calls);
  assert.equal(state.fetches, 1);
  assert.equal(state.aliasLoads, 1);
  assert.equal(a.data.length, 3);
  assert.equal(b.data.length, 1);
});

test("single-flight failure is shared, then cleared so the next call retries", async () => {
  const { service, state } = setup();
  let release;
  state.gate = new Promise((r) => (release = r));
  state.fail = true;
  const calls = [service.list(ADMIN), service.list(ADMIN)].map((p) => p.then(() => "ok", (e) => e.statusCode));
  release();
  assert.deepEqual(await Promise.all(calls), [503, 503]);
  assert.equal(state.fetches, 1);
  state.gate = null;
  state.fail = false;
  assert.equal((await service.list(ADMIN)).data.length, 3);
});

test("filter sede: within scope narrows; outside scope -> 403 FORBIDDEN_SEDE", async () => {
  const { service } = setup();
  assert.deepEqual(ced(await service.list(ADMIN, { sede: "s2" })), ["222222"]);
  assert.deepEqual(ced(await service.list(VIEWER_S1, { sede: "s1" })), ["111111"]);
  await assert.rejects(service.list(VIEWER_S1, { sede: "s2" }), { statusCode: 403, code: "FORBIDDEN_SEDE" });
  assert.equal((await service.list(PLANNER_ALL, { sede: "s2" })).data.length, 1);
});

test("filter cargo: contains, case and accent insensitive", async () => {
  const { service } = setup();
  assert.deepEqual(ced(await service.list(ADMIN, { cargo: "cajera" })), ["111111", "333333"]);
  assert.deepEqual(ced(await service.list(ADMIN, { cargo: "BODÉG" })), ["222222"]);
});

test("filter q: name or cedula contains, case and accent insensitive", async () => {
  const { service } = setup();
  assert.deepEqual(ced(await service.list(ADMIN, { q: "perez" })), ["111111"]);
  assert.deepEqual(ced(await service.list(ADMIN, { q: "MARIA" })), ["333333"]);
  assert.deepEqual(ced(await service.list(ADMIN, { q: "2222" })), ["222222"]);
  assert.deepEqual(ced(await service.list(ADMIN, { q: "0011" })), ["111111"]);
  assert.equal((await service.list(ADMIN, { q: "zzz" })).total, 0);
});

test("filters combine (AND)", async () => {
  const { service } = setup();
  assert.deepEqual(ced(await service.list(ADMIN, { cargo: "cajera", sede: "s1" })), ["111111"]);
  assert.deepEqual(ced(await service.list(ADMIN, { cargo: "bodega", sede: "s1" })), []);
});

test("logs mapping counters only (no PII)", async () => {
  const { service, state } = setup();
  await service.list(ADMIN);
  const text = JSON.stringify(state.logs);
  assert.match(text, /inactive/);
  assert.doesNotMatch(text, /Ana|111111|No cargar/);
});

test("alias repo reads sugerido_sede_aliases into a Map keyed by alias", async () => {
  const seen = [];
  const client = {
    from: (t) => ({
      select: async (c) => (seen.push([t, c]), { data: [{ alias: "centro", sede_id: "s1" }], error: null }),
    }),
  };
  const map = await createSedeAliasRepo(client).loadAliasMap();
  assert.ok(map instanceof Map);
  assert.equal(map.get("centro"), "s1");
  assert.deepEqual(seen, [["sugerido_sede_aliases", "alias, sede_id"]]);
  const bad = { from: () => ({ select: async () => ({ data: null, error: new Error("x") }) }) };
  await assert.rejects(createSedeAliasRepo(bad).loadAliasMap());
});
