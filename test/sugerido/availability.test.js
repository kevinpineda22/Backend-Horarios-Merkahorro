import test from "node:test";
import assert from "node:assert/strict";

import { computeAvailability } from "../../src/modules/sugerido/domain/availability.js";

const WEEK = "2026-10-26"; // Monday
const settings = { ordinaryWeeklyHours: 42, overtimeWeeklyHours: 12, dailyMaxHours: 10, maxWorkingDaysPerWeek: 6 };
const pool = (...ids) => ids.map((cedula) => ({ cedula }));
const abs = (cedula, start, end) => ({ cedula, start, end });
const run = (over = {}) => computeAvailability({ weekStart: WEEK, pool: pool("1", "2", "3"), absences: [], settings, ...over });

test("no absences: full pool every day, capacity = pool x weekly hours", () => {
  const r = run();
  assert.deepEqual(Object.values(r.available), [3, 3, 3, 3, 3, 3, 3]);
  assert.equal(Object.keys(r.available)[0], WEEK);
  assert.equal(r.ordinaryCapH, 126); // 3 x 42
  assert.equal(r.maxCapH, 162); // 3 x 54
});

test("absence removes the cashier only on the absent days", () => {
  const r = run({ absences: [abs("1", "2026-10-26", "2026-10-27")] });
  assert.equal(r.available["2026-10-26"], 2);
  assert.equal(r.available["2026-10-27"], 2);
  assert.equal(r.available["2026-10-28"], 3);
});

test("one absent day is absorbed by the rest day; two days cost capacity", () => {
  const one = run({ absences: [abs("1", "2026-10-26", "2026-10-26")] });
  assert.equal(one.ordinaryCapH, 126); // 7 - 1 = 6 workdays, still the full 6
  const two = run({ absences: [abs("1", "2026-10-26", "2026-10-27")] });
  assert.equal(two.ordinaryCapH, 119); // 42 + 42 + 42 x 5/6
  assert.equal(two.maxCapH, 54 + 54 + 45); // 54 x 5/6 = 45
});

test("maxWorkingDaysPerWeek drives the workday count and the pro-rating", () => {
  const s = { ...settings, maxWorkingDaysPerWeek: 5 };
  assert.equal(run({ settings: s }).ordinaryCapH, 126);
  const r = run({ settings: s, absences: [abs("1", "2026-10-26", "2026-10-28")] }); // 4 workdays of 5
  assert.equal(r.ordinaryCapH, 42 + 42 + 42 * (4 / 5));
});

test("fully absent cashier contributes no hours", () => {
  const r = run({ absences: [abs("1", "2026-10-01", "2026-12-01")] });
  assert.equal(r.ordinaryCapH, 84);
  assert.equal(r.available["2026-10-30"], 2);
});

test("absences of people outside the pool are ignored; duplicate pool entries count once", () => {
  const r = run({ pool: pool("1", "1", "2"), absences: [abs("99", "2026-10-26", "2026-10-30")] });
  assert.equal(r.available[WEEK], 2);
  assert.equal(r.ordinaryCapH, 84);
});

test("overtimeNeeded is strictly above ordinary capacity; weeklyShortfall strictly above max", () => {
  const h = (n) => ({ [WEEK]: n });
  assert.equal(run({ requiredHoursByDay: h(126) }).overtimeNeeded, false);
  assert.equal(run({ requiredHoursByDay: h(126.25) }).overtimeNeeded, true);
  assert.equal(run({ requiredHoursByDay: h(162) }).weeklyShortfall, false);
  assert.equal(run({ requiredHoursByDay: h(162.25) }).weeklyShortfall, true);
});

test("requiredH sums all days", () => {
  const r = run({ requiredHoursByDay: { [WEEK]: 10, "2026-10-27": 5.5 } });
  assert.equal(r.requiredH, 15.5);
});

test("dailyShortfall compares required hours against available x dailyMaxHours", () => {
  const ok = run({ requiredHoursByDay: { [WEEK]: 30 } });
  assert.equal(ok.dailyShortfall[WEEK], false);
  const bad = run({ requiredHoursByDay: { [WEEK]: 30.25 } });
  assert.equal(bad.dailyShortfall[WEEK], true);
  assert.equal(bad.dailyShortfall["2026-10-27"], false);
  const absent = run({ absences: [abs("1", WEEK, WEEK)], requiredHoursByDay: { [WEEK]: 20.25 } });
  assert.equal(absent.dailyShortfall[WEEK], true); // 2 x 10 = 20
});

test("empty pool: zero capacity and any demand is a shortfall", () => {
  const r = run({ pool: [], requiredHoursByDay: { [WEEK]: 1 } });
  assert.equal(r.available[WEEK], 0);
  assert.equal(r.maxCapH, 0);
  assert.equal(r.weeklyShortfall, true);
  assert.equal(r.dailyShortfall[WEEK], true);
});

test("validates settings at the boundary", () => {
  for (const key of Object.keys(settings)) {
    assert.throws(() => run({ settings: { ...settings, [key]: NaN } }), new RegExp(key));
    assert.throws(() => run({ settings: { ...settings, [key]: "42" } }), new RegExp(key));
  }
  assert.throws(() => run({ settings: { ...settings, maxWorkingDaysPerWeek: 0 } }), /maxWorkingDaysPerWeek/);
});

test("pool cedula with surrounding whitespace still matches an absence cedula without it", () => {
  const r = run({ pool: pool(" 1 ", "2", "3"), absences: [abs("1", "2026-10-26", "2026-10-26")] });
  assert.equal(r.available["2026-10-26"], 2);
});
