import test from "node:test";
import assert from "node:assert/strict";

const { licenciaSummary, LICENCIA_DAY_HOURS } = await import("../../src/modules/horarios/domain/payrollLicencias.js");

// Week of Monday 2026-11-16 .. Sunday 2026-11-22 (period = that week).
const FROM = "2026-11-16";
const TO = "2026-11-22";
const lic = (subtipo, fechaInicio, fechaFin) => ({ subtipo, fechaInicio, fechaFin });
const week = (workedHours) => [{ weekStart: FROM, workedHours }];
const worked = (...dates) => new Set(dates);

test("a paid licence pays the day at 7 h (42 h / 6 days)", () => {
  assert.equal(LICENCIA_DAY_HOURS, 7);
});

test("Ana, paid licence Mon-Tue, works Wed-Sat 28 h: 14 h of licence are paid (28 + 14 = 42)", () => {
  const out = licenciaSummary({
    licencias: [lic("Remunerada", "2026-11-16", "2026-11-17")],
    weeks: week(28),
    workedDates: worked("2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"),
    from: FROM,
    to: TO,
  });
  assert.deepEqual(out, { licenciaRemuneradaHoras: 14, licenciaNoRemuneradaDias: 0 });
});

test("Ana, unpaid licence Mon-Tue: 2 days to deduct, no licence hours paid", () => {
  const out = licenciaSummary({
    licencias: [lic("No remunerada", "2026-11-16", "2026-11-17")],
    weeks: week(28),
    workedDates: worked("2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"),
    from: FROM,
    to: TO,
  });
  assert.deepEqual(out, { licenciaRemuneradaHoras: 0, licenciaNoRemuneradaDias: 2 });
});

test("a paid licence never takes the week above 42 h", () => {
  // Whole week on licence, nothing worked: 7 days x 7 h = 49, capped at 42.
  assert.equal(licenciaSummary({ licencias: [lic("Remunerada", FROM, TO)], weeks: week(0), workedDates: worked(), from: FROM, to: TO }).licenciaRemuneradaHoras, 42);
  // Already 40 h worked: only 2 h of licence fit.
  assert.equal(licenciaSummary({ licencias: [lic("Remunerada", FROM, FROM)], weeks: week(40), workedDates: worked(), from: FROM, to: TO }).licenciaRemuneradaHoras, 2);
});

test("days that were worked anyway are neither paid as licence nor deducted; days outside the period are ignored", () => {
  const out = licenciaSummary({
    licencias: [lic("No remunerada", "2026-11-10", "2026-11-18")],
    weeks: week(35),
    workedDates: worked("2026-11-17"),
    from: FROM,
    to: TO,
  });
  assert.equal(out.licenciaNoRemuneradaDias, 2); // 16 and 18; 17 was worked; 10-15 are before the period
});

test("two weeks: the 42 h cap is per week", () => {
  const out = licenciaSummary({
    licencias: [lic("Remunerada", "2026-11-22", "2026-11-23")],
    weeks: [{ weekStart: "2026-11-16", workedHours: 42 }, { weekStart: "2026-11-23", workedHours: 0 }],
    workedDates: worked(),
    from: "2026-11-16",
    to: "2026-11-29",
  });
  assert.equal(out.licenciaRemuneradaHoras, 7); // Sunday 22 does not fit (42 h worked), Monday 23 does
});

test("no licences: zeros", () => {
  assert.deepEqual(licenciaSummary({ licencias: [], weeks: week(42), workedDates: worked(), from: FROM, to: TO }), { licenciaRemuneradaHoras: 0, licenciaNoRemuneradaDias: 0 });
});
