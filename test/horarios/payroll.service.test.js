import test from "node:test";
import assert from "node:assert/strict";
import { createPayrollService } from "../../src/modules/horarios/payroll.service.js";

const ADMIN = { role: "admin", sedeIds: null };
const PLANNER = { role: "planner", sedeIds: ["copacabana"] };
const VIEWER = { role: "viewer", sedeIds: ["copacabana"] };

// Two whole weeks: Mon 2026-10-26 .. Sun 2026-11-08. Nov 1 is a Sunday.
const FROM = "2026-10-26";
const TO = "2026-11-08";
const NOW = () => new Date("2026-11-20T12:00:00Z"); // period already finished
const HOLIDAYS = { "2026-11-02": "Todos los Santos" };

const sh = (cedula, sede, fecha, start, end, over = {}) => ({
  sede_id: sede,
  siesa_code: over.code === undefined ? "003" : over.code,
  cedula,
  fecha,
  tipo: over.tipo ?? "TRABAJO",
  start_time: `${start}:00`,
  end_time: `${end}:00`,
  break_minutes: over.brk ?? 0,
  cargo: over.cargo ?? "Cajero",
});
const emp = (cedula, sedeId, nombre = `Nombre ${cedula}`) => ({ cedula, nombre, cargo: "Cajero", sedeId });

const CAT = [
  { sede_id: "copacabana", siesa_code: "003", activo: true },
  { sede_id: "bello", siesa_code: "011", activo: true },
  { sede_id: "sinCodigo", siesa_code: null, activo: true },
];
const published = (sede, week) => ({ sede_id: sede, week_start: week, state: "PUBLICADO" });
const ALL_PUBLISHED = CAT.flatMap((s) => [published(s.sede_id, FROM), published(s.sede_id, "2026-11-02")]);

function build({
  shifts = [],
  schedules = ALL_PUBLISHED,
  sedes = CAT,
  directory = [],
  directoryError = null,
  paidCut = null,
  now = NOW,
} = {}) {
  const calls = { shifts: [], schedules: [], dir: [] };
  const repo = {
    async listShiftsInRange(args) { calls.shifts.push(args); return shifts; },
    async listSchedulesInRange(args) { calls.schedules.push(args); return schedules; },
    async listSedes() { return sedes; },
    async findPaidCutOverlapping() { return paidCut; },
  };
  const empleadosService = {
    async list(access, opts) {
      calls.dir.push([access, opts]);
      if (directoryError) throw directoryError;
      return { data: directory, total: directory.length, actualizado: "x" };
    },
  };
  const service = createPayrollService({ repo, empleadosService, getHolidayFn: (f) => HOLIDAYS[f] ?? null, now });
  return { service, calls };
}
const report = (service, access = ADMIN, q = {}) => service.report(access, { from: FROM, to: TO, ...q });
const rejects = (p, status, code) =>
  assert.rejects(p, (e) => (assert.equal(e.statusCode, status), assert.equal(e.code, code), true));
const warn = (r, code) => r.warnings.find((w) => w.code === code);

test("rejects periods that are not 1 or 2 whole Monday-Sunday weeks with PAYROLL_PERIOD_INVALID", async () => {
  const { service } = build();
  for (const q of [
    { from: "2026-10-27", to: "2026-11-09" },
    { from: FROM, to: "2026-11-07" },
    { from: FROM, to: "2026-11-15" },
    { from: FROM, to: undefined },
    { from: "garbage", to: TO },
  ]) await rejects(service.report(ADMIN, q), 400, "PAYROLL_PERIOD_INVALID");
});

test("viewer gets 403; planner asking for another sede gets 403 before any read", async () => {
  const { service, calls } = build();
  await rejects(report(service, VIEWER), 403, "FORBIDDEN_ROLE");
  await rejects(report(service, null), 403, "FORBIDDEN_ROLE");
  await rejects(report(service, PLANNER, { sedeId: "bello" }), 403, "FORBIDDEN_SEDE");
  assert.equal(calls.shifts.length, 0);
});

test("without from/to the default period (14-day block containing today) is used", async () => {
  const { service } = build({ now: () => new Date("2026-11-05T15:00:00Z") });
  const r = await service.report(ADMIN, {});
  assert.deepEqual([r.period.from, r.period.to, r.period.days, r.period.isDefault], [FROM, TO, 14, true]);
  assert.equal((await report(service)).period.isDefault, false);
});

test("loads every sede from the day before the period (previous-day spill) and the schedules of its weeks", async () => {
  const { service, calls } = build();
  await report(service);
  assert.deepEqual(calls.shifts, [{ from: "2026-10-25", to: TO }]);
  assert.deepEqual(calls.schedules, [{ fromWeek: FROM, toWeek: "2026-11-02" }]);
  assert.equal(calls.dir[0][0].role, "admin", "directory is loaded with admin scope, filtered later");
});

test("computes concepts, the response shape and the SIESA tuple of a Sunday shift", async () => {
  const { service } = build({
    shifts: [sh("10010001", "copacabana", "2026-11-01", "08:00", "16:00")],
    directory: [emp("10010001", "copacabana")],
  });
  const r = await report(service);
  assert.equal(r.source, "live");
  assert.deepEqual(r.period.weeks, [
    { weekStart: FROM, weekEnd: "2026-11-01" },
    { weekStart: "2026-11-02", weekEnd: "2026-11-08" },
  ]);
  assert.deepEqual(r.calendar.sundays, ["2026-11-01", "2026-11-08"]);
  assert.deepEqual(r.calendar.holidays, [{ fecha: "2026-11-02", nombre: "Todos los Santos" }]);
  const row = r.rows.find((x) => x.cedula === "10010001");
  assert.deepEqual(
    [row.nombre, row.cargo, row.sedeId, row.siesaCode, row.branchSource, row.inDirectory],
    ["Nombre 10010001", "Cajero", "copacabana", "003", "shift", true],
  );
  assert.equal(row.totals.dominicales, 8);
  assert.equal(row.totals.workedHours, 8);
  assert.equal(row.weeks.length, 2);
  assert.deepEqual(r.totals, { employees: 1, extras: 0, nocturnas: 0, dominicales: 8, festivos: 0 });
  assert.equal(r.siesa.headers.length, 20);
  assert.deepEqual(r.siesa.rows, [[10010001, "003", 103, "", "", "", 8, 0, "", "", "", "", "", "", "", "", "", "", "", ""]]);
  assert.deepEqual(r.siesa.errors, []);
  assert.deepEqual([r.paidCut, r.cut, r.variations], [null, null, null]);
  assert.deepEqual(r.permissions, { canSaveCut: false, canVoidCut: false });
});

test("holidays come from the injected calendar and count in festivos", async () => {
  const { service } = build({
    shifts: [sh("10010001", "copacabana", "2026-11-02", "08:00", "12:00")],
    directory: [emp("10010001", "copacabana")],
  });
  const r = await report(service);
  assert.equal(r.rows[0].totals.festivos, 4);
});

test("branch = last TRABAJO shift of the period (W5), also taking the sede of that shift", async () => {
  const { service } = build({
    shifts: [
      sh("10010001", "copacabana", "2026-10-27", "08:00", "12:00", { code: "003" }),
      sh("10010001", "bello", "2026-11-03", "08:00", "12:00", { code: "011" }),
      sh("10010001", "copacabana", "2026-11-04", "08:00", "12:00", { code: "003", tipo: "DESCANSO" }),
    ],
    directory: [emp("10010001", "copacabana")],
  });
  const row = (await report(service)).rows[0];
  assert.deepEqual([row.siesaCode, row.sedeId, row.branchSource], ["011", "bello", "shift"]);
});

test("last shift ties are broken by later start time, then by sede id ascending", async () => {
  const { service } = build({
    shifts: [
      sh("10010001", "bello", "2026-11-03", "08:00", "10:00", { code: "011" }),
      sh("10010001", "copacabana", "2026-11-03", "14:00", "16:00", { code: "003" }),
      sh("10020002", "copacabana", "2026-11-03", "08:00", "10:00", { code: "003" }),
      sh("10020002", "bello", "2026-11-03", "08:00", "10:00", { code: "011" }),
    ],
    directory: [emp("10010001", "bello"), emp("10020002", "bello")],
  });
  const rows = Object.fromEntries((await report(service)).rows.map((r) => [r.cedula, r]));
  assert.equal(rows["10010001"].siesaCode, "003");
  assert.equal(rows["10020002"].siesaCode, "011", "bello < copacabana");
});

test("branch falls back: shift snapshot -> sede catalog -> directory sede -> missing", async () => {
  const { service } = build({
    shifts: [
      sh("10010001", "bello", "2026-11-03", "08:00", "12:00", { code: null }),
      sh("10020002", "sinCodigo", "2026-11-03", "08:00", "12:00", { code: null }),
      sh("10030003", "sinCodigo", "2026-11-03", "08:00", "12:00", { code: null }),
    ],
    directory: [emp("10010001", "copacabana"), emp("10020002", "copacabana"), emp("10030003", "sinCodigo")],
  });
  const rows = Object.fromEntries((await report(service)).rows.map((r) => [r.cedula, r]));
  assert.deepEqual([rows["10010001"].siesaCode, rows["10010001"].branchSource], ["011", "sede"]);
  assert.deepEqual([rows["10020002"].siesaCode, rows["10020002"].branchSource], ["003", "directory"]);
  assert.deepEqual([rows["10030003"].siesaCode, rows["10030003"].branchSource], [null, null]);
});

test("A4: missing branch blocks only rows with hours to export; the row is left out of the SIESA rows", async () => {
  const { service } = build({
    shifts: [
      sh("10030003", "sinCodigo", "2026-11-01", "08:00", "12:00", { code: null }),
      sh("10040004", "sinCodigo", "2026-11-03", "08:00", "12:00", { code: null }),
    ],
    directory: [emp("10030003", "sinCodigo", "Ana"), emp("10040004", "sinCodigo", "Beto"), emp("10050005", "sinCodigo", "Cris")],
  });
  const r = await report(service);
  assert.deepEqual(r.siesa.errors, [{ cedula: "10030003", nombre: "Ana", code: "MISSING_BRANCH" }]);
  assert.deepEqual(r.siesa.rows, []);
  assert.deepEqual(warn(r, "MISSING_BRANCH").cedulas, ["10030003"]);
});

test("zero-hour directory employees are listed with 0.00 and never exported", async () => {
  const { service } = build({ directory: [emp("10090009", "copacabana", "Zoe")] });
  const r = await report(service);
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.deepEqual([row.nombre, row.sedeId, row.siesaCode, row.branchSource], ["Zoe", "copacabana", "003", "directory"]);
  assert.deepEqual(row.totals, { workedHours: 0, extras: 0, nocturnas: 0, dominicales: 0, festivos: 0, sundayFestiveHours: 0 });
  assert.equal(r.totals.employees, 1);
  assert.deepEqual(r.siesa.rows, []);
});

test("people with only rest shifts and no directory entry do not become rows", async () => {
  const { service } = build({ shifts: [sh("10080008", "copacabana", "2026-11-03", "08:00", "12:00", { tipo: "DESCANSO" })] });
  assert.deepEqual((await report(service)).rows, []);
});

test("planner sees only rows attributed to their sedes but hours still count across sedes", async () => {
  const shifts = [
    // 5 x 8.5h in copacabana + Saturday 8h in bello = 50.5h; the last shift is in copacabana (Sunday).
    ...["26", "27", "28", "29", "30"].map((d) => sh("10010001", "copacabana", `2026-10-${d}`, "06:00", "14:30")),
    sh("10010001", "bello", "2026-10-31", "08:00", "16:00", { code: "011" }),
    sh("10010001", "copacabana", "2026-11-01", "08:00", "10:00"),
    sh("10020002", "bello", "2026-10-27", "08:00", "12:00", { code: "011" }),
  ];
  const { service } = build({ shifts, directory: [emp("10010001", "copacabana"), emp("10020002", "bello")] });
  const r = await report(service, PLANNER);
  assert.deepEqual(r.rows.map((x) => x.cedula), ["10010001"]);
  assert.ok(r.rows[0].totals.extras > 0, "bello hours counted toward the weekly limit");
  assert.equal(r.totals.employees, 1);
  assert.equal((await report(service, ADMIN)).rows.length, 2);
  const filtered = await report(service, ADMIN, { sedeId: "bello" });
  assert.deepEqual(filtered.rows.map((x) => x.cedula), ["10020002"]);
});

test("warning UNPUBLISHED_WEEKS lists BORRADOR sede-weeks that have work in accessible sedes", async () => {
  const schedules = [
    published("copacabana", FROM),
    { sede_id: "copacabana", week_start: "2026-11-02", state: "BORRADOR" },
    { sede_id: "bello", week_start: FROM, state: "BORRADOR" },
    published("bello", "2026-11-02"),
    { sede_id: "sinCodigo", week_start: FROM, state: "BORRADOR" }, // no shifts there
    published("sinCodigo", "2026-11-02"),
  ];
  const shifts = [
    sh("10010001", "copacabana", "2026-11-03", "08:00", "12:00"),
    sh("10020002", "bello", "2026-10-27", "08:00", "12:00", { code: "011" }),
  ];
  const { service } = build({ shifts, schedules, directory: [emp("10010001", "copacabana"), emp("10020002", "bello")] });
  assert.deepEqual(warn(await report(service), "UNPUBLISHED_WEEKS").items, [
    { sedeId: "bello", weekStart: FROM },
    { sedeId: "copacabana", weekStart: "2026-11-02" },
  ]);
  assert.deepEqual(warn(await report(service, PLANNER), "UNPUBLISHED_WEEKS").items, [
    { sedeId: "copacabana", weekStart: "2026-11-02" },
  ]);
  assert.deepEqual(warn(await report(service, ADMIN, { sedeId: "bello" }), "UNPUBLISHED_WEEKS").items, [
    { sedeId: "bello", weekStart: FROM },
  ]);
  const hours = (await report(service)).rows.find((r) => r.cedula === "10010001").totals.workedHours;
  assert.equal(hours, 4, "draft hours are counted (A1)");
});

test("warning SEDE_WEEK_WITHOUT_SCHEDULE flags active sede-weeks with no schedule (partial data)", async () => {
  const schedules = [published("copacabana", FROM), published("copacabana", "2026-11-02"), published("bello", FROM)];
  const sedes = [...CAT, { sede_id: "cerrada", siesa_code: "099", activo: false }];
  const { service } = build({ schedules, sedes });
  assert.deepEqual(warn(await report(service), "SEDE_WEEK_WITHOUT_SCHEDULE").items, [
    { sedeId: "bello", weekStart: "2026-11-02" },
    { sedeId: "sinCodigo", weekStart: FROM },
    { sedeId: "sinCodigo", weekStart: "2026-11-02" },
  ]);
  assert.equal(warn(await report(service, PLANNER), "SEDE_WEEK_WITHOUT_SCHEDULE"), undefined, "planner's sede is fully scheduled");
});

test("only the always-present PARTIAL_COVERAGE warning is emitted when everything is in order", async () => {
  const { service } = build({
    shifts: [sh("10010001", "copacabana", "2026-11-03", "08:00", "12:00")],
    directory: [emp("10010001", "copacabana")],
  });
  assert.deepEqual((await report(service)).warnings, [{ code: "PARTIAL_COVERAGE" }]);
});

test("PARTIAL_COVERAGE is present for every role, scope and period kind", async () => {
  const { service } = build({ now: () => new Date("2026-11-05T15:00:00Z") });
  for (const [access, q] of [[ADMIN, {}], [PLANNER, {}], [ADMIN, { from: FROM, to: TO }], [ADMIN, { from: FROM, to: TO, sedeId: "bello" }]]) {
    assert.deepEqual((await service.report(access, q)).warnings.filter((w) => w.code === "PARTIAL_COVERAGE"), [{ code: "PARTIAL_COVERAGE" }]);
  }
});

test("default period follows the Bogota calendar day at the UTC boundary", async () => {
  const at = (iso) => build({ now: () => new Date(iso) }).service;
  const before = await at("2026-11-09T04:59:00Z").report(ADMIN, {});
  assert.deepEqual([before.period.from, before.period.to], ["2026-10-26", "2026-11-08"]);
  const after = await at("2026-11-09T05:00:00Z").report(ADMIN, {});
  assert.deepEqual([after.period.from, after.period.to], ["2026-11-09", "2026-11-22"]);
});

test("planner-scoped report never leaks other sedes' cedulas into cedula warnings", async () => {
  const { service } = build({
    shifts: [
      sh("10010001", "copacabana", "2026-11-03", "08:00", "12:00"),
      // bello: not in directory, no branch code, overlapping shifts
      sh("10090009", "bello", "2026-11-03", "08:00", "12:00", { code: null }),
      sh("10090009", "sinCodigo", "2026-11-03", "10:00", "14:00", { code: null }),
    ],
    directory: [emp("10010001", "copacabana")],
  });
  const admin = await report(service, ADMIN);
  assert.ok(warn(admin, "NOT_IN_DIRECTORY").cedulas.includes("10090009"));
  assert.ok(warn(admin, "SHIFT_OVERLAP_DEDUPED").cedulas.includes("10090009"));
  const r = await report(service, PLANNER);
  for (const code of ["NOT_IN_DIRECTORY", "MISSING_BRANCH", "SHIFT_OVERLAP_DEDUPED"]) {
    assert.equal(JSON.stringify(warn(r, code) ?? {}).includes("10090009"), false, code);
  }
  assert.equal(JSON.stringify(r.siesa).includes("10090009"), false);
});

test("warning NOT_IN_DIRECTORY keeps the row (and exports it) for people who worked but are not active in SIESA", async () => {
  const { service } = build({
    shifts: [sh("10070007", "copacabana", "2026-11-01", "08:00", "12:00")],
    directory: [emp("10010001", "bello")],
  });
  const r = await report(service);
  assert.deepEqual(warn(r, "NOT_IN_DIRECTORY").cedulas, ["10070007"]);
  const row = r.rows.find((x) => x.cedula === "10070007");
  assert.deepEqual([row.nombre, row.inDirectory, row.sedeId, row.cargo], [null, false, "copacabana", "Cajero"]);
  assert.equal(r.siesa.rows.length, 1);
});

test("warning SHIFT_OVERLAP_DEDUPED lists people whose overlapping minutes were counted once", async () => {
  const { service } = build({
    shifts: [
      sh("10010001", "copacabana", "2026-11-03", "08:00", "12:00"),
      sh("10010001", "bello", "2026-11-03", "10:00", "14:00", { code: "011" }),
    ],
    directory: [emp("10010001", "copacabana")],
  });
  const r = await report(service);
  assert.deepEqual(warn(r, "SHIFT_OVERLAP_DEDUPED").cedulas, ["10010001"]);
  assert.equal(r.rows[0].totals.workedHours, 6);
});

test("warning PERIOD_OVERLAPS_PAID_CUT and paidCut come from the (slice 2) repository seam", async () => {
  const cut = { id: 7, from: FROM, to: TO };
  const { service } = build({ paidCut: cut });
  const r = await report(service);
  assert.deepEqual(r.paidCut, cut);
  assert.deepEqual(warn(r, "PERIOD_OVERLAPS_PAID_CUT").cut, cut);
});

test("a repo without findPaidCutOverlapping (slice 1b) reports no paid cut", async () => {
  const repo = { listShiftsInRange: async () => [], listSchedulesInRange: async () => ALL_PUBLISHED, listSedes: async () => CAT };
  const service = createPayrollService({ repo, empleadosService: { list: async () => ({ data: [] }) }, now: NOW });
  assert.equal((await report(service)).paidCut, null);
});

test("warning PERIOD_NOT_FINISHED while today (Bogota) is inside or before the end of the period", async () => {
  const at = (iso) => build({ now: () => new Date(iso) }).service;
  assert.ok(warn(await report(at("2026-11-08T20:00:00-05:00")), "PERIOD_NOT_FINISHED"), "last day, Bogota");
  assert.ok(warn(await report(at("2026-11-05T12:00:00Z")), "PERIOD_NOT_FINISHED"));
  assert.equal(warn(await report(at("2026-11-09T00:30:00-05:00")), "PERIOD_NOT_FINISHED"), undefined);
});

test("DIRECTORY_UNAVAILABLE degrades: report still computes, names null, no zero-hour rows, no NOT_IN_DIRECTORY", async () => {
  const boom = Object.assign(new Error("down"), { statusCode: 503, code: "STAFF_SOURCE_UNAVAILABLE" });
  const { service } = build({
    shifts: [sh("10010001", "copacabana", "2026-11-01", "08:00", "12:00")],
    directoryError: boom,
  });
  const r = await report(service);
  assert.ok(warn(r, "DIRECTORY_UNAVAILABLE"));
  assert.equal(warn(r, "NOT_IN_DIRECTORY"), undefined);
  assert.deepEqual([r.rows[0].nombre, r.rows[0].inDirectory, r.rows[0].siesaCode], [null, null, "003"]);
  assert.equal(r.rows.length, 1);
});

test("a failing directory is logged without PII and still degrades to DIRECTORY_UNAVAILABLE", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  const { service } = build({ directoryError: new TypeError("x is not a function") });
  assert.ok(warn(await report(service), "DIRECTORY_UNAVAILABLE"));
  assert.deepEqual(logged, [["[payroll] directory unavailable:", "x is not a function"]]);
});

test("fingerprint: admin without sedeId only; ignores names and zero-hour rows; changes with hours", async () => {
  const base = { shifts: [sh("10010001", "copacabana", "2026-11-01", "08:00", "12:00")] };
  const a = await report(build({ ...base, directory: [emp("10010001", "copacabana", "Ana")] }).service);
  const renamed = await report(
    build({ ...base, directory: [emp("10010001", "copacabana", "Ana M."), emp("10090009", "bello", "Zoe")] }).service,
  );
  const more = await report(
    build({ shifts: [sh("10010001", "copacabana", "2026-11-01", "08:00", "13:00")], directory: [emp("10010001", "copacabana")] }).service,
  );
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(a.fingerprint, renamed.fingerprint);
  assert.notEqual(a.fingerprint, more.fingerprint);
  const { service } = build({ ...base, directory: [emp("10010001", "copacabana")] });
  assert.equal((await report(service, PLANNER)).fingerprint, null);
  assert.equal((await report(service, ADMIN, { sedeId: "copacabana" })).fingerprint, null);
});

test("fingerprint depends on the holiday list and on the branch code", async () => {
  const shifts = [sh("10010001", "copacabana", "2026-11-01", "08:00", "12:00")];
  const directory = [emp("10010001", "copacabana")];
  const a = await report(build({ shifts, directory }).service);
  const noHoliday = createPayrollService({
    repo: { listShiftsInRange: async () => shifts, listSchedulesInRange: async () => ALL_PUBLISHED, listSedes: async () => CAT },
    empleadosService: { list: async () => ({ data: directory }) },
    getHolidayFn: () => null,
    now: NOW,
  });
  assert.notEqual(a.fingerprint, (await report(noHoliday)).fingerprint);
  const otherBranch = await report(
    build({ shifts: [sh("10010001", "copacabana", "2026-11-01", "08:00", "12:00", { code: "004" })], directory }).service,
  );
  assert.notEqual(a.fingerprint, otherBranch.fingerprint);
});

test("rows are ordered by name then cedula, rows without name last", async () => {
  const { service } = build({
    shifts: [sh("10070007", "copacabana", "2026-11-03", "08:00", "12:00")],
    directory: [emp("10020002", "copacabana", "Zoe"), emp("10010001", "copacabana", "Ana"), emp("10030003", "copacabana", "Ana")],
  });
  assert.deepEqual((await report(service)).rows.map((r) => r.cedula), ["10010001", "10030003", "10020002", "10070007"]);
});
