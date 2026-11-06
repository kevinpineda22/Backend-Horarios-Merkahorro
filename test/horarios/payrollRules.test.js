import test from "node:test";
import assert from "node:assert/strict";
import {
  NIGHT_START_MINUTE,
  NIGHT_END_MINUTE,
  ORDINARY_WEEK_MINUTES,
  hours,
  roundHours,
  weekMinuteBuckets,
  weekNovelties,
  employeeNovelties,
} from "../../src/modules/horarios/domain/payrollRules.js";

// 2026-08-31 is a Monday (start of the first payroll cut).
const W = "2026-08-31";
const W2 = "2026-09-07";
const DAYS = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];
const [MON, TUE, WED, THU, FRI, SAT, SUN] = DAYS;
const NONE = new Set();

const work = (fecha, startTime, endTime, breakMinutes = 0) => ({
  cedula: "1012345678",
  sedeId: "003",
  fecha,
  tipo: "TRABAJO",
  startTime,
  endTime,
  breakMinutes,
});

const week = (rows, weekStart = W, holidays = NONE) =>
  weekNovelties(weekMinuteBuckets(rows, weekStart, holidays), weekStart);

const monToFri8h = () => [MON, TUE, WED, THU, FRI].map((d) => work(d, "08:00", "16:00"));

test("constants and hour helpers", () => {
  assert.equal(NIGHT_START_MINUTE, 1140);
  assert.equal(NIGHT_END_MINUTE, 360);
  assert.equal(ORDINARY_WEEK_MINUTES, 2520);
  assert.equal(hours(90), 1.5);
  assert.equal(hours(1), 0.02);
  assert.equal(hours(undefined), 0);
  assert.equal(roundHours(1.005), 1.01);
  assert.equal(roundHours("2.5"), 2.5);
});

test("exactly 2520 minutes: no extras; the 2521st minute is extra", () => {
  const base = [...monToFri8h(), work(SAT, "08:00", "10:00")];
  assert.equal(week(base).extras, 0);
  assert.equal(week(base).workedHours, 42);
  const plusOne = [...monToFri8h(), work(SAT, "08:00", "10:01")];
  const w = week(plusOne);
  assert.equal(w.extras, 0.02);
  assert.equal(w.workedHours, 42.02);
});

test("Saturday -> Sunday crossing, no break: nocturnas 8, dominicales 6", () => {
  const w = week([work(SAT, "22:00", "06:00")]);
  assert.equal(w.nocturnas, 8);
  assert.equal(w.dominicales, 6);
  assert.equal(w.extras, 0);
  assert.equal(w.festivos, 0);
});

test("Sunday -> Monday crossing: Monday minutes belong to the next week", () => {
  const rows = [work(SUN, "22:00", "06:00")];
  const w1 = week(rows, W);
  const w2 = week(rows, W2);
  assert.equal(w1.nocturnas, 2);
  assert.equal(w1.dominicales, 2);
  assert.equal(w2.nocturnas, 6);
  assert.equal(w2.dominicales, 0);
});

test("previous-day spill: only the minutes inside the week count", () => {
  const w = week([work("2026-08-30", "20:00", "04:00")]);
  assert.equal(w.workedHours, 4);
  assert.equal(w.nocturnas, 4);
  assert.equal(w.dominicales, 0);
});

test("centered break moving minutes across 19:00", () => {
  const w = week([work(MON, "15:00", "23:00", 60)]);
  assert.equal(w.workedHours, 7);
  assert.equal(w.nocturnas, 3.5);
  assert.equal(w.extras, 0);
});

test("a break longer than the shift is clamped to the span", () => {
  const w = week([work(MON, "08:00", "09:00", 120)]);
  assert.equal(w.workedHours, 0);
});

test("overlapping shifts count their shared minutes once and flag the overlap", () => {
  const b = weekMinuteBuckets([work(MON, "08:00", "12:00"), work(MON, "10:00", "14:00")], W, NONE);
  assert.equal(b.total, 360);
  assert.equal(b.hasOverlap, true);
  const single = weekMinuteBuckets([work(MON, "08:00", "12:00")], W, NONE);
  assert.equal(single.hasOverlap, false);
});

test("rest rows and shifts without times never work", () => {
  const rows = [
    { ...work(MON, "08:00", "16:00"), tipo: "DESCANSO" },
    { ...work(TUE, "08:00", "16:00"), tipo: "COMPENSATORIO" },
    { ...work(WED, "08:00", "16:00"), startTime: null, endTime: null },
  ];
  assert.equal(week(rows).workedHours, 0);
});

test("44 h week: Saturday 10:00-12:00 are the extras", () => {
  const w = week([...monToFri8h(), work(SAT, "08:00", "12:00")]);
  assert.equal(w.extras, 2);
  assert.equal(w.nocturnas, 0);
  assert.equal(w.workedHours, 44);
});

test("48 h week: 6 h extras, 3 h of them at night counted in nocturnas too", () => {
  const w = week([...monToFri8h(), work(SAT, "14:00", "22:00")]);
  assert.equal(w.extras, 6);
  assert.equal(w.nocturnas, 3);
});

test("holiday Sunday counts in dominicales and festivos", () => {
  const w = week([work(SUN, "08:00", "16:00")], W, new Set([SUN]));
  assert.equal(w.dominicales, 8);
  assert.equal(w.festivos, 8);
  assert.equal(w.sundayFestiveHours, 8);
});

test("a Monday holiday applies to that minute's own date", () => {
  const w = week([work(MON, "08:00", "16:00")], W, new Set([MON]));
  assert.equal(w.festivos, 8);
  assert.equal(w.dominicales, 0);
});

test("night is judged on the minute's own date and wall clock", () => {
  // Monday 05:00-07:00: only 05:00-06:00 is night.
  const w = week([work(MON, "05:00", "07:00")]);
  assert.equal(w.nocturnas, 1);
});

test("rounding: nocturnas rounds each part before adding (0.66, not 0.67)", () => {
  const rows = [
    work(MON, "00:00", "00:20"), // 20 ordinary night minutes (first in the week)
    ...monToFri8h(),
    work(SAT, "08:00", "09:40"), // reaches exactly 2520
    work(SAT, "23:00", "23:20"), // 20 extra night minutes
  ];
  const w = week(rows);
  assert.equal(w.nocturnas, 0.66);
  assert.equal(w.extras, 0.33);
});

test("cut total: weekly 6 and 2 Sunday hours add up to 8", () => {
  const rows = [work(SUN, "08:00", "14:00"), work("2026-09-13", "08:00", "10:00")];
  const cut = employeeNovelties(rows, W, "2026-09-13", NONE);
  assert.equal(cut.weeks.length, 2);
  assert.deepEqual(cut.weeks.map((w) => w.weekStart), [W, W2]);
  assert.equal(cut.weeks[0].weekEnd, SUN);
  assert.equal(cut.totals.dominicales, 8);
  assert.equal(cut.totals.workedHours, 8);
});

test("a one-week cut has a single week", () => {
  const cut = employeeNovelties([work(MON, "08:00", "16:00")], W, SUN, NONE);
  assert.equal(cut.weeks.length, 1);
  assert.equal(cut.totals.workedHours, 8);
});

test("a Sunday-night shift in a 14-day cut splits across both weeks", () => {
  const cut = employeeNovelties([work(SUN, "22:00", "06:00")], W, "2026-09-13", NONE);
  assert.equal(cut.weeks[0].nocturnas, 2);
  assert.equal(cut.weeks[1].nocturnas, 6);
  assert.equal(cut.totals.nocturnas, 8);
  assert.equal(cut.totals.dominicales, 2);
});
