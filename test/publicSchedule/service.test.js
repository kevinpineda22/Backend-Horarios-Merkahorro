import test from "node:test";
import assert from "node:assert/strict";

const { createPublicScheduleService, WEEKS_BACK, WEEKS_AHEAD } = await import(
  "../../src/modules/publicSchedule/publicSchedule.service.js"
);
const { createHttpError } = await import("../../src/shared/http/HttpError.js");
const { NOW, SCHED_A, SCHED_B, SCHED_OLD, fakes, shiftRow } = await import("./helpers.js");

const build = (opts) => {
  const f = fakes(opts);
  return { ...f, service: createPublicScheduleService({ ...f, now: () => NOW }) };
};
const call = (service, cedula = "123456") => service.consulta({ cedula });

test("returns the employee header without cedula, restrictions or ids", async () => {
  const { service } = build({ shifts: [shiftRow()] });
  const { data } = await call(service);
  assert.deepEqual(data.empleado, { nombre: "Ana Perez", sede: "Copacabana", cargo: "Cajera" });
  const dump = JSON.stringify(data);
  assert.ok(!dump.includes("123456"), "cedula must not be echoed");
  assert.ok(!dump.includes("secret restriction"));
});

test("maps a worked day: HH:MM times, hours net of break, lunch and break minutes", async () => {
  const { service } = build({ shifts: [shiftRow()] });
  const { data } = await call(service);
  assert.deepEqual(data.semanas[0].dias[0], {
    fecha: "2026-11-10",
    tipo: "TRABAJO",
    entrada: "08:00",
    salida: "17:00",
    horas: 8,
    descansoMinutos: 60,
    almuerzo: "12:00",
    festivo: null,
  });
});

test("rest days carry no times or hours; holidays are named; shifts crossing midnight count correctly", async () => {
  const { service } = build({
    shifts: [
      shiftRow({ fecha: "2026-11-11", tipo: "DESCANSO", start_time: null, end_time: null, break_minutes: 0, lunch_start: null }),
      shiftRow({ fecha: "2026-11-16", schedule_id: SCHED_B, start_time: "22:00:00", end_time: "06:00:00", break_minutes: 0, lunch_start: null }),
      shiftRow({ fecha: "2026-11-15", tipo: "COMPENSATORIO", start_time: null, end_time: null, break_minutes: 0, lunch_start: null }),
    ],
  });
  const { data } = await call(service);
  const [w1, w2] = data.semanas;
  assert.deepEqual(
    w1.dias.map((d) => [d.fecha, d.tipo, d.entrada, d.horas]),
    [
      ["2026-11-11", "DESCANSO", null, 0],
      ["2026-11-15", "COMPENSATORIO", null, 0],
    ],
  );
  assert.equal(w2.dias[0].horas, 8);
  // 2026-11-16 is a national holiday (Independencia de Cartagena, moved to Monday).
  assert.equal(typeof w2.dias[0].festivo, "string");
});

test("groups days by week, sorts weeks ascending and totals hours per week", async () => {
  const { service } = build({
    shifts: [
      shiftRow({ fecha: "2026-11-17", schedule_id: SCHED_B }),
      shiftRow({ fecha: "2026-11-11" }),
      shiftRow({ fecha: "2026-11-10" }),
    ],
  });
  const { data } = await call(service);
  assert.deepEqual(
    data.semanas.map((w) => [w.weekStart, w.weekEnd, w.totalHoras, w.dias.length]),
    [
      ["2026-11-09", "2026-11-15", 16, 2],
      ["2026-11-16", "2026-11-22", 8, 1],
    ],
  );
  assert.deepEqual(data.semanas[0].dias.map((d) => d.fecha), ["2026-11-10", "2026-11-11"]);
});

test("queries only the published window: 4 weeks back through 8 ahead of the Bogota Monday", async () => {
  const { service, calls } = build({ shifts: [shiftRow()] });
  await call(service);
  assert.equal(WEEKS_BACK, 4);
  assert.equal(WEEKS_AHEAD, 8);
  const range = calls.find(([n]) => n === "listPublishedSchedulesInRange")[1];
  assert.deepEqual(range, { from: "2026-10-12", to: "2027-01-04" });
  const shifts = calls.find(([n]) => n === "listShiftsByCedulaInSchedules")[1];
  assert.equal(shifts.cedula, "123456");
  assert.deepEqual(shifts.scheduleIds, [SCHED_A, SCHED_B]);
});

test("the Monday is computed on the Bogota clock, not UTC (Sunday 21:00 Bogota is already Monday UTC)", async () => {
  const f = fakes({ shifts: [shiftRow()] });
  const service = createPublicScheduleService({ ...f, now: () => new Date("2026-11-16T02:00:00Z") }); // Sun 2026-11-15 21:00 Bogota
  await service.consulta({ cedula: "123456" });
  assert.equal(f.calls.find(([n]) => n === "listPublishedSchedulesInRange")[1].from, "2026-10-12");
});

test("shifts of schedules that are not in the published list are ignored (drafts never leak)", async () => {
  const { service } = build({ shifts: [shiftRow({ schedule_id: SCHED_OLD }), shiftRow({ fecha: "2026-11-11" })] });
  const { data } = await call(service);
  assert.equal(data.semanas.length, 1);
  assert.deepEqual(data.semanas[0].dias.map((d) => d.fecha), ["2026-11-11"]);
});

test("novedades expose only tipo and dates, never observation, details, files or audit fields", async () => {
  const { service, calls } = build({
    shifts: [shiftRow()],
    novedades: [
      {
        tipo: "Vacaciones",
        fecha_inicio: "2026-11-20",
        fecha_fin: "2026-11-30",
        observacion: "private note",
        detalles: { x: 1 },
        adjunto_path: "a/b.pdf",
        created_by: "u1",
      },
      { tipo: "Algo raro", fecha_inicio: "2026-12-01", fecha_fin: "2026-12-01" },
    ],
  });
  const { data } = await call(service);
  assert.deepEqual(data.novedades, [
    { tipo: "Vacaciones", fechaInicio: "2026-11-20", fechaFin: "2026-11-30" },
    { tipo: "Novedad", fechaInicio: "2026-12-01", fechaFin: "2026-12-01" },
  ]);
  const args = calls.find(([n]) => n === "listPublicByCedula")[1];
  assert.deepEqual(args, { cedula: "123456", desde: "2026-10-12", hasta: "2027-01-10" });
  const dump = JSON.stringify(data);
  for (const leak of ["private note", "a/b.pdf", "created_by", "detalles"]) assert.ok(!dump.includes(leak), leak);
});

test("an active employee with no published shifts gets an empty list (and no novedades read)", async () => {
  const { service, calls } = build({ shifts: [] });
  const { data } = await call(service);
  assert.deepEqual(data.semanas, []);
  assert.deepEqual(data.novedades, []);
  assert.ok(!calls.some(([n]) => n === "listPublicByCedula"));
});

test("unknown or inactive employee -> generic 404 NOT_FOUND and no schedule reads", async () => {
  const { service, calls } = build({ employee: null });
  await assert.rejects(call(service), (e) => {
    assert.equal(e.statusCode, 404);
    assert.equal(e.code, "NOT_FOUND");
    assert.equal(e.message, "No encontramos horarios para esa cédula.");
    return true;
  });
  assert.ok(!calls.some(([n]) => n.startsWith("list")));
});

test("directory outage -> 503 with a Spanish message that hides the upstream detail", async () => {
  const { service } = build({
    directoryError: createHttpError(503, "Employee directory is temporarily unavailable", "STAFF_SOURCE_UNAVAILABLE"),
  });
  await assert.rejects(call(service), (e) => {
    assert.equal(e.statusCode, 503);
    assert.equal(e.code, "SERVICE_UNAVAILABLE");
    assert.ok(!/directory/i.test(e.message));
    return true;
  });
});
