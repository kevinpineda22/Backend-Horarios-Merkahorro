import test from "node:test";
import assert from "node:assert/strict";

const { createHorariosRepo } = await import("../../src/modules/horarios/horarios.supabase.js");
const { createNovedadesRepo } = await import("../../src/modules/novedades/novedades.supabase.js");
const { createRateLimiter } = await import("../../src/shared/http/rateLimit.js");
const { createEmpleadosService } = await import("../../src/modules/empleados/empleados.service.js");

/** Chainable query fake: records every call and resolves to { data } when awaited. */
function fakeClient(data) {
  const log = [];
  const q = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (resolve) => resolve({ data, error: null });
        return (...args) => (log.push([prop, ...args]), q);
      },
    },
  );
  return { log, from: (t) => (log.push(["from", t]), q) };
}

test("listShiftsByCedulaInRange filters by cedula and fecha window and selects no sensitive column", async () => {
  const c = fakeClient([{ schedule_id: "s1" }]);
  const rows = await createHorariosRepo(c).listShiftsByCedulaInRange({ cedula: "123456", from: "2026-10-12", to: "2027-01-10" });
  assert.equal(rows.length, 1);
  const cols = c.log.find(([m]) => m === "select")[1].split(",").map((s) => s.trim());
  for (const banned of ["observacion", "cargo", "updated_by", "created_by", "cedula", "id"]) assert.ok(!cols.includes(banned), banned);
  assert.ok(cols.includes("schedule_id"));
  assert.deepEqual(c.log.filter(([m]) => ["eq", "gte", "lte"].includes(m)), [
    ["eq", "cedula", "123456"],
    ["gte", "fecha", "2026-10-12"],
    ["lte", "fecha", "2027-01-10"],
  ]);
  assert.ok(!c.log.some(([m]) => m === "in"), "no id list in the shifts query");
});

test("listPublishedSchedulesByIds filters state PUBLICADO in the query and skips it without ids", async () => {
  const c = fakeClient([{ id: "s1", week_start: "2026-11-09" }]);
  const repo = createHorariosRepo(c);
  assert.deepEqual(await repo.listPublishedSchedulesByIds([]), []);
  assert.equal(c.log.length, 0);
  const rows = await repo.listPublishedSchedulesByIds(["s1", "s2"]);
  assert.equal(rows.length, 1);
  assert.deepEqual(c.log.filter(([m]) => ["from", "eq", "in"].includes(m)), [
    ["from", "sede_week_schedules"],
    ["eq", "state", "PUBLICADO"],
    ["in", "id", ["s1", "s2"]],
  ]);
});

test("novedades listPublicByCedula selects only tipo and dates and excludes cancelled rows", async () => {
  const c = fakeClient([]);
  await createNovedadesRepo(c).listPublicByCedula({ cedula: "123456", desde: "2026-10-12", hasta: "2027-01-10" });
  assert.equal(c.log.find(([m]) => m === "select")[1], "tipo, fecha_inicio, fecha_fin");
  assert.ok(c.log.some(([m, col, v]) => m === "eq" && col === "anulada" && v === false));
});

/** Drives the limiter with a fake req/res; `status` is emitted on res 'finish' like Express would. */
function limiterHarness(opts) {
  let t = 0;
  const limiter = createRateLimiter({ ...opts, now: () => t });
  const hit = (ip, status = 200) => {
    let err = null;
    let onFinish = () => {};
    const res = { statusCode: status, set() {}, once: (_event, fn) => (onFinish = fn) };
    limiter({ headers: { "x-forwarded-for": ip }, socket: {} }, res, (e) => (err = e ?? null));
    if (!err) onFinish();
    return err;
  };
  return { hit, advance: (ms) => (t += ms) };
}

test("rate limiter: 200s do not consume quota", () => {
  const { hit } = limiterHarness({ max: 2 });
  for (let i = 0; i < 50; i++) assert.equal(hit("a", 200), null);
});

test("rate limiter: 400 and 404 count; the request after max failures gets 429", () => {
  const { hit } = limiterHarness({ max: 3 });
  assert.equal(hit("a", 404), null);
  assert.equal(hit("a", 400), null);
  assert.equal(hit("a", 404), null);
  assert.equal(hit("a", 200).statusCode, 429); // over the limit: even a valid lookup is blocked
  assert.equal(hit("b", 200), null); // other IPs are unaffected
});

test("rate limiter: default config blocks after 20 failures and the window resets", () => {
  const { hit, advance } = limiterHarness({});
  for (let i = 0; i < 20; i++) assert.equal(hit("a", 404), null);
  assert.equal(hit("a", 404).statusCode, 429);
  advance(5 * 60 * 1000 + 1);
  assert.equal(hit("a", 200), null);
});

test("rate limiter: the map stays bounded (prunes expired, then evicts the oldest)", () => {
  const { hit, advance } = limiterHarness({ max: 2, windowMs: 1000, maxKeys: 3 });
  for (const ip of ["a", "b", "c"]) hit(ip, 404);
  advance(1001); // a, b, c are expired
  hit("d", 404); // map full -> expired entries pruned
  hit("e", 404);
  hit("f", 404); // d, e, f live
  hit("d", 404);
  hit("d", 404); // d reached max (2)
  assert.equal(hit("d", 200).statusCode, 429);
  hit("g", 404); // full of live entries -> the oldest (d) is evicted
  assert.equal(hit("d", 200), null, "d was evicted, so it starts from zero");
  // e and f survive: failing again does not throw and the limit still applies to live keys
  hit("f", 404);
  assert.equal(hit("f", 200).statusCode, 429);
});

test("empleados.findActiveByCedula normalizes the input and only knows active rows", async () => {
  const rows = [
    { cedula: "00111111", nombre: "Ana", cargo: "Cajera", sede: "Centro", activo: true },
    { cedula: "444444", nombre: "Inactivo", cargo: "Cajera", sede: "Centro", activo: false },
  ];
  const service = createEmpleadosService({
    client: { fetchEmpleadosActivos: async () => ({ data: rows, actualizado: "2026-01-01T00:00:00.000Z" }) },
    aliasRepo: { loadAliasMap: async () => new Map([["centro", "s1"]]) },
    logger: null,
  });
  assert.equal((await service.findActiveByCedula("111.111")).nombre, "Ana");
  assert.equal(await service.findActiveByCedula("444444"), null);
  assert.equal(await service.findActiveByCedula("999999"), null);
});

test("listShiftsByCedulaInRange also selects the frozen segments, and falls back without them while migration 014 is missing", async () => {
  const warnings = [];
  let calls = 0;
  const selects = [];
  const q = {
    select: (cols) => (selects.push(cols), q),
    eq: () => q, gte: () => q, lte: () => q, order: () => q,
    range: async () => (++calls === 1 ? { data: null, error: { code: "42703", message: 'column "segments" does not exist' } } : { data: [{ schedule_id: "s1" }], error: null }),
  };
  const repo = createHorariosRepo({ from: () => q }, { logger: { warn: (m) => warnings.push(m) } });
  const rows = await repo.listShiftsByCedulaInRange({ cedula: "123456", from: "2026-10-12", to: "2027-01-10" });
  assert.equal(rows.length, 1);
  assert.ok(selects[0].split(",").map((c) => c.trim()).includes("segments"));
  assert.ok(!selects[1].includes("segments"));
  assert.equal(warnings.length, 1);
});

test("listShiftsByCedulaInRange rethrows any other database error", async () => {
  const q = { select: () => q, eq: () => q, gte: () => q, lte: () => q, order: () => q, range: async () => ({ data: null, error: { code: "XX000", message: "boom" } }) };
  const repo = createHorariosRepo({ from: () => q }, { logger: { warn() {} } });
  await assert.rejects(repo.listShiftsByCedulaInRange({ cedula: "1", from: "a", to: "b" }), { code: "XX000" });
});
