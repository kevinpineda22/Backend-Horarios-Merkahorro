import test from "node:test";
import assert from "node:assert/strict";
import { createPayrollService } from "../../src/modules/horarios/payroll.service.js";

const ADMIN = { role: "admin", sedeIds: null };
const PLANNER = { role: "planner", sedeIds: ["copacabana"] };
const PLANNER_ALL = { role: "planner", sedeIds: null };
const VIEWER = { role: "viewer", sedeIds: ["copacabana"] };
const USER = { id: "11111111-1111-4111-8111-111111111111" };

// Two whole weeks: Mon 2026-10-26 .. Sun 2026-11-08. Nov 1 is a Sunday, Nov 2 a holiday.
const FROM = "2026-10-26";
const TO = "2026-11-08";
const NOW = () => new Date("2026-11-20T12:00:00Z");
const HOLIDAYS = { "2026-11-02": "Todos los Santos" };

const sh = (cedula, sede, fecha, start, end, over = {}) => ({
  sede_id: sede,
  siesa_code: over.code === undefined ? "003" : over.code,
  cedula,
  fecha,
  tipo: "TRABAJO",
  start_time: `${start}:00`,
  end_time: `${end}:00`,
  break_minutes: 0,
  cargo: "Cajero",
});
const emp = (cedula, sedeId, nombre = `Nombre ${cedula}`) => ({ cedula, nombre, cargo: "Cajero", sedeId });
const CAT = [
  { sede_id: "copacabana", siesa_code: "003", activo: true },
  { sede_id: "bello", siesa_code: "011", activo: true },
];
const ALL_PUBLISHED = CAT.flatMap((s) => [
  { sede_id: s.sede_id, week_start: FROM, state: "PUBLICADO" },
  { sede_id: s.sede_id, week_start: "2026-11-02", state: "PUBLICADO" },
]);

const CUT_ROW = {
  id: 7, period_start: FROM, period_end: TO, state: "PAGADO", employees: 2,
  extras: 4, nocturnas: 2, dominicales: 8, festivos: 0, sundays: ["2026-11-01", "2026-11-08"],
  holidays: [{ fecha: "2026-11-02", nombre: "Todos los Santos" }], engine_version: "1",
  created_by: "u-creator", created_at: "2026-11-09T10:00:00Z", voided_by: null, voided_at: null, void_reason: null,
};

function build({
  shifts = [],
  directory = [],
  directoryError = null,
  paidCut = null,
  lastPaid = null,
  cutRow = CUT_ROW,
  cutLines = [],
  cutWeeks = [],
  sums = new Map(),
  cuts = [],
  saveError = null,
  profiles = { "u-creator": "Ana Admin", [USER.id]: "Beto Admin", "u-voider": "Vera Void" },
  withProfiles = true,
  now = NOW,
} = {}) {
  const calls = { save: [], void: [], getCut: [], listCuts: [], sums: [], lastPaid: 0, shifts: 0 };
  const repo = {
    async listShiftsInRange() { calls.shifts += 1; return shifts; },
    async listSchedulesInRange() { return ALL_PUBLISHED; },
    async listSedes() { return CAT; },
    async findPaidCutOverlapping() { return paidCut; },
    async findLastPaidCut() { calls.lastPaid += 1; return lastPaid; },
    async saveCut(args) {
      calls.save.push(args);
      if (saveError) throw saveError;
      return { ...cutRow, created_by: args.actor };
    },
    async voidCut(args) {
      calls.void.push(args);
      return { ...cutRow, state: "ANULADO", voided_by: args.actor, voided_at: "2026-11-10T10:00:00Z", void_reason: args.reason ?? null };
    },
    async listCuts(args) { calls.listCuts.push(args); return cuts; },
    async getCut(id) { calls.getCut.push(id); return cutRow ? { cut: cutRow, lines: cutLines, weeks: cutWeeks } : null; },
    async sumCutLines(args) { calls.sums.push(args); return sums; },
  };
  const empleadosService = {
    async list() {
      if (directoryError) throw directoryError;
      return { data: directory };
    },
  };
  const profilesRepo = withProfiles ? { async findById(id) { return id in profiles ? { nombre: profiles[id] } : null; } } : undefined;
  const service = createPayrollService({ repo, empleadosService, profilesRepo, getHolidayFn: (f) => HOLIDAYS[f] ?? null, now });
  return { service, calls };
}
const rejects = (p, status, code) =>
  assert.rejects(p, (e) => (assert.equal(e.statusCode, status), assert.equal(e.code, code), true));
const report = (service, access = ADMIN, q = {}) => service.report(access, { from: FROM, to: TO, ...q });

const WORKED = {
  shifts: [sh("10010001", "copacabana", "2026-11-01", "08:00", "16:00")],
  directory: [emp("10010001", "copacabana"), emp("10010002", "copacabana"), emp("ABC-1", "copacabana")],
};

// ---------------------------------------------------------------------------
// report seams
// ---------------------------------------------------------------------------

test("the default period continues the day after the last PAGADO cut", async () => {
  const { service, calls } = build({ lastPaid: { id: 3, from: "2026-08-31", to: "2026-09-13" } });
  const r = await service.report(ADMIN, {});
  assert.deepEqual([r.period.from, r.period.to, r.period.isDefault], ["2026-09-14", "2026-09-27", true]);
  assert.equal(calls.lastPaid, 1);
});

test("without any PAGADO cut the default period is the block containing today; explicit dates skip the lookup", async () => {
  const { service, calls } = build({ now: () => new Date("2026-11-05T15:00:00Z") });
  const r = await service.report(ADMIN, {});
  assert.deepEqual([r.period.from, r.period.to], [FROM, TO]);
  await report(service);
  assert.equal(calls.lastPaid, 1, "only the default period needs the last cut");
});

test("permissions: canSaveCut = admin and no PAGADO cut in the way; canVoidCut = admin", async () => {
  const { service } = build();
  assert.deepEqual((await report(service)).permissions, { canSaveCut: true, canVoidCut: true });
  assert.deepEqual((await report(service, PLANNER)).permissions, { canSaveCut: false, canVoidCut: false });
  const paid = build({ paidCut: { id: 7, from: FROM, to: TO } });
  const r = await report(paid.service);
  assert.deepEqual(r.permissions, { canSaveCut: false, canVoidCut: true });
  assert.deepEqual(r.paidCut, { id: 7, from: FROM, to: TO });
  assert.equal(r.warnings.find((w) => w.code === "PERIOD_OVERLAPS_PAID_CUT").cut.id, 7);
});

// ---------------------------------------------------------------------------
// saveCut
// ---------------------------------------------------------------------------

async function fingerprintOf(service) {
  return (await report(service)).fingerprint;
}

test("saveCut is admin only", async () => {
  const { service, calls } = build(WORKED);
  const fingerprint = await fingerprintOf(service);
  await rejects(service.saveCut(PLANNER, USER, { from: FROM, to: TO, fingerprint }), 403, "FORBIDDEN_ROLE");
  await rejects(service.saveCut(VIEWER, USER, { from: FROM, to: TO, fingerprint }), 403, "FORBIDDEN_ROLE");
  assert.equal(calls.save.length, 0);
});

test("saveCut rejects a period that is not 1 or 2 whole weeks with 400 and reads nothing", async () => {
  const { service, calls } = build(WORKED);
  await rejects(service.saveCut(ADMIN, USER, { from: "2026-10-27", to: TO, fingerprint: "x" }), 400, "PAYROLL_PERIOD_INVALID");
  assert.equal(calls.shifts, 0);
});

test("saveCut answers 503 when the directory is unavailable (never saves a degraded snapshot)", async () => {
  const { service, calls } = build({ ...WORKED, directoryError: new Error("down") });
  const fingerprint = await fingerprintOf(service);
  await rejects(service.saveCut(ADMIN, USER, { from: FROM, to: TO, fingerprint }), 503, "DIRECTORY_UNAVAILABLE");
  assert.equal(calls.save.length, 0);
});

test("saveCut answers 409 PAYROLL_REPORT_CHANGED when the fingerprint is missing or stale", async () => {
  const { service, calls } = build(WORKED);
  await rejects(service.saveCut(ADMIN, USER, { from: FROM, to: TO, fingerprint: "stale" }), 409, "PAYROLL_REPORT_CHANGED");
  await rejects(service.saveCut(ADMIN, USER, { from: FROM, to: TO }), 409, "PAYROLL_REPORT_CHANGED");
  assert.equal(calls.save.length, 0);
  // The data the admin reviewed changed after loading: the old fingerprint no longer matches.
  const before = await fingerprintOf(service);
  const changed = build({ ...WORKED, shifts: [...WORKED.shifts, sh("10010001", "copacabana", "2026-11-08", "08:00", "12:00")] });
  await rejects(changed.service.saveCut(ADMIN, USER, { from: FROM, to: TO, fingerprint: before }), 409, "PAYROLL_REPORT_CHANGED");
});

test("saveCut answers 409 PAYROLL_CUT_OVERLAP with the cut in the way before touching the database", async () => {
  const cut = { id: 3, from: "2026-10-19", to: "2026-11-01" };
  const { service, calls } = build({ ...WORKED, paidCut: cut });
  const fingerprint = await fingerprintOf(service);
  await assert.rejects(service.saveCut(ADMIN, USER, { from: FROM, to: TO, fingerprint }), (e) => {
    assert.deepEqual([e.statusCode, e.code], [409, "PAYROLL_CUT_OVERLAP"]);
    assert.deepEqual(e.details, { cut });
    return true;
  });
  assert.equal(calls.save.length, 0);
});

test("saveCut refuses a cut with no employees: 422 PAYROLL_CUT_EMPTY and nothing is saved", async () => {
  const { service, calls } = build({ shifts: [], directory: [] });
  const fingerprint = await fingerprintOf(service);
  await assert.rejects(service.saveCut(ADMIN, USER, { from: FROM, to: TO, fingerprint }), (e) => {
    assert.equal(e.statusCode, 422);
    assert.equal(e.code, "PAYROLL_CUT_EMPTY");
    assert.equal(e.message, "No hay empleados para guardar en este corte.");
    return true;
  });
  assert.equal(calls.save.length, 0);
});

test("saveCut recomputes on the server and stores a full snapshot incl. zero-hour employees", async () => {
  const { service, calls } = build(WORKED);
  const fingerprint = await fingerprintOf(service);
  // Client-sent numbers are not part of the contract: only from, to and fingerprint are read.
  const out = await service.saveCut(ADMIN, USER, { from: FROM, to: TO, fingerprint, dominicales: 99, rows: [{ cedula: "1" }] });

  assert.equal(calls.save.length, 1);
  const { from, to, actor, snapshot } = calls.save[0];
  assert.deepEqual([from, to, actor], [FROM, TO, USER.id]);
  assert.equal(snapshot.engineVersion, "1");
  assert.deepEqual(snapshot.sundays, ["2026-11-01", "2026-11-08"]);
  assert.deepEqual(snapshot.holidays, [{ fecha: "2026-11-02", nombre: "Todos los Santos" }]);

  const byCedula = Object.fromEntries(snapshot.lines.map((l) => [l.cedula, l]));
  assert.deepEqual(Object.keys(byCedula).sort(), ["10010001", "10010002"], "bad-format cedula dropped, zero-hour kept");
  const worked = byCedula["10010001"];
  assert.deepEqual(
    [worked.nombre, worked.cargo, worked.sede_id, worked.siesa_code, worked.branch_source, worked.in_directory],
    ["Nombre 10010001", "Cajero", "copacabana", "003", "shift", true],
  );
  assert.deepEqual(
    [worked.worked_hours, worked.extras, worked.nocturnas, worked.dominicales, worked.festivos, worked.sunday_festive_hours],
    [8, 0, 0, 8, 0, 0],
  );
  assert.deepEqual(worked.weeks.map((w) => [w.week_start, w.worked_hours, w.dominicales, w.has_overlap]), [
    [FROM, 8, 8, false],
    ["2026-11-02", 0, 0, false],
  ]);
  assert.deepEqual(Object.keys(worked.weeks[0]).sort(), [
    "dominicales", "extras", "festivos", "has_overlap", "nocturnas", "sunday_festive_hours", "week_start", "worked_hours",
  ]);
  const zero = byCedula["10010002"];
  assert.deepEqual([zero.worked_hours, zero.extras, zero.siesa_code, zero.branch_source], [0, 0, "003", "directory"]);
  assert.equal(zero.weeks.length, 2);

  assert.equal(out.cut.id, 7);
  assert.equal(out.cut.createdBy, USER.id);
  assert.equal(out.cut.createdByName, "Beto Admin");
});

test("saveCut propagates the repository error (RPC overlap race, invalid snapshot)", async () => {
  const err = Object.assign(new Error("overlap"), { statusCode: 409, code: "PAYROLL_CUT_OVERLAP" });
  const { service } = build({ ...WORKED, saveError: err });
  const fingerprint = await fingerprintOf(service);
  await assert.rejects(service.saveCut(ADMIN, USER, { from: FROM, to: TO, fingerprint }), (e) => e === err);
});

// ---------------------------------------------------------------------------
// voidCut
// ---------------------------------------------------------------------------

test("voidCut is admin only and forwards id, optional reason and actor", async () => {
  const { service, calls } = build();
  await rejects(service.voidCut(PLANNER, USER, 7, { reason: "x" }), 403, "FORBIDDEN_ROLE");
  assert.equal(calls.void.length, 0);

  const out = await service.voidCut(ADMIN, USER, 7, { reason: "digitado mal" });
  assert.deepEqual(calls.void[0], { id: 7, reason: "digitado mal", actor: USER.id });
  assert.equal(out.cut.state, "ANULADO");
  assert.equal(out.cut.voidedBy, USER.id);
  assert.equal(out.cut.voidedByName, "Beto Admin");
  assert.equal(out.cut.voidReason, "digitado mal");

  await service.voidCut(ADMIN, USER, 7, {});
  assert.equal(calls.void[1].reason, null, "the reason is optional");
});

// ---------------------------------------------------------------------------
// listCuts
// ---------------------------------------------------------------------------

const VOIDED = {
  ...CUT_ROW, id: 5, period_start: "2026-10-12", period_end: "2026-10-25", state: "ANULADO",
  voided_by: "u-voider", voided_at: "2026-10-26T10:00:00Z", void_reason: "error",
};

test("listCuts: viewer is denied; admin gets stored totals, names, lastPaid and nextDefaultFrom", async () => {
  const { service, calls } = build({ cuts: [CUT_ROW, VOIDED], lastPaid: { id: 7, from: FROM, to: TO } });
  await rejects(service.listCuts(VIEWER, {}), 403, "FORBIDDEN_ROLE");
  const out = await service.listCuts(ADMIN, {});
  assert.deepEqual(calls.listCuts, [{ limit: 40 }]);
  assert.deepEqual(out.items.map((c) => [c.id, c.state]), [[7, "PAGADO"], [5, "ANULADO"]]);
  assert.deepEqual(out.items[0], {
    id: 7, from: FROM, to: TO, state: "PAGADO", employees: 2,
    totals: { extras: 4, nocturnas: 2, dominicales: 8, festivos: 0 },
    engineVersion: "1", createdBy: "u-creator", createdByName: "Ana Admin", createdAt: "2026-11-09T10:00:00Z",
    voidedBy: null, voidedByName: null, voidedAt: null, voidReason: null,
  });
  assert.deepEqual([out.items[1].voidedByName, out.items[1].voidedAt, out.items[1].voidReason], ["Vera Void", "2026-10-26T10:00:00Z", "error"]);
  assert.deepEqual(out.lastPaid, { id: 7, from: FROM, to: TO });
  assert.equal(out.nextDefaultFrom, "2026-11-09");
  assert.equal(calls.sums.length, 0, "admin reads the stored totals");
});

test("listCuts nextDefaultFrom without a PAGADO cut is the start of the block containing today; limit is forwarded", async () => {
  const { service, calls } = build({ now: () => new Date("2026-11-05T15:00:00Z") });
  const out = await service.listCuts(ADMIN, { limit: 5 });
  assert.deepEqual(calls.listCuts, [{ limit: 5 }]);
  assert.deepEqual([out.lastPaid, out.nextDefaultFrom, out.items], [null, FROM, []]);
});

test("listCuts for a scoped planner sums only the lines of their sedes (no company-wide totals leak)", async () => {
  const sums = new Map([[7, { employees: 1, extras: 1, nocturnas: 0, dominicales: 2, festivos: 0 }]]);
  const { service, calls } = build({ cuts: [CUT_ROW, VOIDED], sums });
  const out = await service.listCuts(PLANNER, {});
  assert.deepEqual(calls.sums, [{ cutIds: [7, 5], sedeIds: ["copacabana"] }]);
  assert.deepEqual([out.items[0].employees, out.items[0].totals], [1, { extras: 1, nocturnas: 0, dominicales: 2, festivos: 0 }]);
  assert.deepEqual([out.items[1].employees, out.items[1].totals], [0, { extras: 0, nocturnas: 0, dominicales: 0, festivos: 0 }]);
  const all = build({ cuts: [CUT_ROW] });
  assert.equal((await all.service.listCuts(PLANNER_ALL, {})).items[0].totals.extras, 4, "an unscoped planner sees every sede");
  assert.equal(all.calls.sums.length, 0);
});

test("listCuts works without a profiles repository (names null)", async () => {
  const { service } = build({ cuts: [CUT_ROW], withProfiles: false });
  assert.equal((await service.listCuts(ADMIN, {})).items[0].createdByName, null);
});

// ---------------------------------------------------------------------------
// getCut: the frozen snapshot, never recomputed
// ---------------------------------------------------------------------------

const line = (cedula, over = {}) => ({
  cut_id: 7, cedula, nombre: `Nombre ${cedula}`, cargo: "Cajero", sede_id: "copacabana", siesa_code: "003",
  branch_source: "shift", in_directory: true, worked_hours: 8, extras: 0, nocturnas: 0, dominicales: 8,
  festivos: 0, sunday_festive_hours: 0, ...over,
});
const weeksOf = (cedula, first, second = 0) => [
  { cut_id: 7, cedula, week_start: FROM, worked_hours: first, extras: 0, nocturnas: 0, dominicales: first, festivos: 0, sunday_festive_hours: 0, has_overlap: false },
  { cut_id: 7, cedula, week_start: "2026-11-02", worked_hours: second, extras: 0, nocturnas: 0, dominicales: second, festivos: 0, sunday_festive_hours: 0, has_overlap: false },
];
const SNAP = {
  cutLines: [
    line("10010001"),
    line("10010002", { worked_hours: 0, dominicales: 0, nombre: "Zero Cero" }),
    line("10010003", { sede_id: "bello", siesa_code: "011", dominicales: 3, worked_hours: 3 }),
    line("10010004", { siesa_code: null, branch_source: null, dominicales: 1, worked_hours: 1, nombre: "Sin Sede" }),
  ],
  cutWeeks: [
    ...weeksOf("10010001", 8),
    ...weeksOf("10010002", 0),
    ...weeksOf("10010003", 3),
    ...weeksOf("10010004", 1),
  ],
};

test("getCut returns the frozen snapshot as a report, without recomputing anything", async () => {
  const { service, calls } = build(SNAP);
  const r = await service.getCut(ADMIN, 7, {});
  assert.equal(calls.shifts, 0, "no live reads");
  assert.deepEqual(calls.getCut, [7]);
  assert.equal(r.source, "cut");
  assert.deepEqual(r.period, {
    from: FROM, to: TO, days: 14, isDefault: false,
    weeks: [{ weekStart: FROM, weekEnd: "2026-11-01" }, { weekStart: "2026-11-02", weekEnd: "2026-11-08" }],
  });
  assert.deepEqual(r.calendar, { sundays: CUT_ROW.sundays, holidays: CUT_ROW.holidays });
  assert.deepEqual(r.rows.map((x) => x.cedula), ["10010001", "10010003", "10010004", "10010002"], "ordered by name, then cedula");
  const row = r.rows.find((x) => x.cedula === "10010001");
  assert.deepEqual(
    [row.nombre, row.cargo, row.sedeId, row.siesaCode, row.branchSource, row.inDirectory],
    ["Nombre 10010001", "Cajero", "copacabana", "003", "shift", true],
  );
  assert.deepEqual(row.totals, { workedHours: 8, extras: 0, nocturnas: 0, dominicales: 8, festivos: 0, sundayFestiveHours: 0 });
  assert.deepEqual(row.weeks[0], {
    weekStart: FROM, weekEnd: "2026-11-01", workedHours: 8, extras: 0, nocturnas: 0, dominicales: 8, festivos: 0,
    sundayFestiveHours: 0, hasOverlap: false,
  });
  assert.equal(row.weeks.length, 2);
  assert.deepEqual(r.totals, { employees: 4, extras: 0, nocturnas: 0, dominicales: 12, festivos: 0 });
  assert.equal(r.cut.id, 7);
  assert.equal(r.cut.createdByName, "Ana Admin");
  assert.deepEqual([r.paidCut, r.variations, r.fingerprint], [null, null, null]);
});

test("getCut builds the SIESA rows from the snapshot: zero-hour rows skipped, rows without branch are errors", async () => {
  const { service } = build(SNAP);
  const r = await service.getCut(ADMIN, 7, {});
  assert.equal(r.siesa.headers.length, 20);
  assert.deepEqual(r.siesa.rows.map((x) => [x[0], x[1], x[2], x[6]]), [
    [10010001, "003", 103, 8],
    [10010003, "011", 103, 3],
  ]);
  assert.deepEqual(r.siesa.errors, [{ cedula: "10010004", nombre: "Sin Sede", code: "MISSING_BRANCH" }]);
  const codes = r.warnings.map((w) => w.code);
  assert.ok(codes.includes("PARTIAL_COVERAGE"));
  assert.deepEqual(r.warnings.find((w) => w.code === "MISSING_BRANCH").cedulas, ["10010004"]);
});

test("getCut permissions: canSaveCut false; canVoidCut only for an admin and a PAGADO cut", async () => {
  const pagado = build(SNAP);
  assert.deepEqual((await pagado.service.getCut(ADMIN, 7, {})).permissions, { canSaveCut: false, canVoidCut: true });
  assert.deepEqual((await pagado.service.getCut(PLANNER, 7, {})).permissions, { canSaveCut: false, canVoidCut: false });
  const voided = build({ ...SNAP, cutRow: VOIDED });
  assert.deepEqual((await voided.service.getCut(ADMIN, 5, {})).permissions, { canSaveCut: false, canVoidCut: false });
});

test("getCut scopes rows, totals and the cut counters to a planner's sedes", async () => {
  const { service } = build(SNAP);
  const r = await service.getCut(PLANNER, 7, {});
  assert.ok(r.rows.every((x) => x.sedeId === "copacabana"));
  assert.equal(r.rows.some((x) => x.cedula === "10010003"), false, "another sede is hidden");
  assert.equal(r.totals.employees, 3);
  assert.equal(r.totals.dominicales, 9);
  assert.equal(r.cut.employees, 3);
  assert.equal(r.cut.totals.dominicales, 9, "no company-wide totals leak");
  assert.equal(r.siesa.rows.some((x) => x[0] === 10010003), false);
});

test("getCut with sedeId narrows to that sede; a planner cannot ask for another one", async () => {
  const { service } = build(SNAP);
  const r = await service.getCut(ADMIN, 7, { sedeId: "bello" });
  assert.deepEqual(r.rows.map((x) => x.cedula), ["10010003"]);
  await rejects(service.getCut(PLANNER, 7, { sedeId: "bello" }), 403, "FORBIDDEN_SEDE");
});

test("getCut: viewer 403, unknown id 404 PAYROLL_CUT_NOT_FOUND", async () => {
  await rejects(build(SNAP).service.getCut(VIEWER, 7, {}), 403, "FORBIDDEN_ROLE");
  await rejects(build({ cutRow: null }).service.getCut(ADMIN, 99, {}), 404, "PAYROLL_CUT_NOT_FOUND");
});
