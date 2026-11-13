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

test("listPublishedSchedulesInRange filters state PUBLICADO and the week range", async () => {
  const c = fakeClient([{ id: "s1", week_start: "2026-11-09" }]);
  const rows = await createHorariosRepo(c).listPublishedSchedulesInRange({ from: "2026-10-12", to: "2027-01-04" });
  assert.equal(rows.length, 1);
  assert.deepEqual(c.log.filter(([m]) => ["eq", "gte", "lte"].includes(m)), [
    ["eq", "state", "PUBLICADO"],
    ["gte", "week_start", "2026-10-12"],
    ["lte", "week_start", "2027-01-04"],
  ]);
});

test("listShiftsByCedulaInSchedules selects no sensitive column and skips the query without schedules", async () => {
  const c = fakeClient([]);
  const repo = createHorariosRepo(c);
  assert.deepEqual(await repo.listShiftsByCedulaInSchedules({ cedula: "123456", scheduleIds: [] }), []);
  assert.equal(c.log.length, 0);
  await repo.listShiftsByCedulaInSchedules({ cedula: "123456", scheduleIds: ["s1"] });
  const select = c.log.find(([m]) => m === "select")[1];
  for (const banned of ["observacion", "cargo", "updated_by", "created_by", "cedula", "id,"]) {
    assert.ok(!select.split(",").map((s) => s.trim()).includes(banned.replace(",", "")), banned);
  }
  assert.ok(c.log.some(([m, col, v]) => m === "eq" && col === "cedula" && v === "123456"));
  assert.ok(c.log.some(([m, col]) => m === "in" && col === "schedule_id"));
});

test("novedades listPublicByCedula selects only tipo and dates and excludes cancelled rows", async () => {
  const c = fakeClient([]);
  await createNovedadesRepo(c).listPublicByCedula({ cedula: "123456", desde: "2026-10-12", hasta: "2027-01-10" });
  assert.equal(c.log.find(([m]) => m === "select")[1], "tipo, fecha_inicio, fecha_fin");
  assert.ok(c.log.some(([m, col, v]) => m === "eq" && col === "anulada" && v === false));
});

test("rate limiter: fixed window resets after windowMs and prunes expired keys", () => {
  let t = 0;
  const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => t, maxKeys: 1 });
  const hit = (ip) => {
    let err = null;
    limiter({ headers: { "x-forwarded-for": ip }, socket: {} }, { set() {} }, (e) => (err = e ?? null));
    return err;
  };
  assert.equal(hit("a"), null);
  assert.equal(hit("a"), null);
  assert.equal(hit("a").statusCode, 429);
  t = 1001;
  assert.equal(hit("a"), null);
  assert.equal(hit("b"), null); // triggers prune (maxKeys reached) without breaking
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
