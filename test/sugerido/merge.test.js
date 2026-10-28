import test from "node:test";
import assert from "node:assert/strict";

import { applyOverrides, assembleWeek } from "../../src/modules/sugerido/domain/merge.js";
import { weekDates } from "../../src/modules/sugerido/domain/dates.js";

const WEEK = "2026-10-26";
const settings = {
  ordinaryWeeklyHours: 42,
  overtimeWeeklyHours: 12,
  dailyMaxHours: 10,
  maxWorkingDaysPerWeek: 6,
  utilization: 0.85,
  minCashiers: 1,
};
const FIVE = ["09:00", "09:15", "09:30", "09:45", "10:00"];

// Forecast fixture: Monday has 5 flat slots (7.5 docs = 30 docs/h), other days are empty.
function forecast() {
  const days = weekDates(WEEK).map((fecha, i) => {
    const slots = i === 0 ? FIVE.map((franja) => ({ franja, docs: 7.5, venta: 7500 })) : [];
    return {
      fecha,
      dayType: i === 6 ? "sunday" : "weekday",
      holidayName: null,
      noHistory: i !== 0,
      lowHistory: false,
      slots,
      totals: { docs: slots.length * 7.5, venta: slots.length * 7500, avgTicket: 1000, peakSlots: ["09:00"] },
      inputs: {},
    };
  });
  return { days, inputs: { trendRatio: 1, referenceDates: {}, samples: {} } };
}
const pool = (n) => Array.from({ length: n }, (_, i) => ({ cedula: String(i + 1) }));
const build = (over = {}) =>
  assembleWeek({ weekStart: WEEK, forecast: forecast(), productivity: 10, settings, pool: pool(3), absences: [], ...over });
const slot = (r, fecha, franja) => r.days.find((d) => d.fecha === fecha).slots.find((s) => s.franja === franja);

test("suggested is capped by availability and shortfall is the difference", () => {
  const r = build();
  const mid = slot(r, WEEK, "09:30");
  assert.equal(mid.required, 4);
  assert.equal(mid.available, 3);
  assert.equal(mid.suggested, 3);
  assert.equal(mid.shortfall, 1);
  assert.equal(mid.status, "shortfall");
  const edge = slot(r, WEEK, "09:00");
  assert.deepEqual([edge.required, edge.suggested, edge.shortfall, edge.status], [4, 3, 1, "shortfall"]);
});

test("plenty of cashiers: suggested equals required", () => {
  const mid = slot(build({ pool: pool(10) }), WEEK, "09:30");
  assert.deepEqual([mid.suggested, mid.shortfall, mid.status], [4, 0, "ok"]);
});

test("absences lower availability on that day only; slots are not trimmed", () => {
  const r = build({ absences: [{ cedula: "1", start: WEEK, end: WEEK }, { cedula: "2", start: WEEK, end: WEEK }] });
  const mon = r.days[0];
  assert.equal(mon.available, 1);
  assert.equal(mon.slots.length, 5);
  const mid = slot(r, WEEK, "09:30");
  assert.deepEqual([mid.required, mid.suggested, mid.shortfall], [4, 1, 3]);
  assert.equal(r.days[1].available, 3);
});

test("zero available: suggested 0 and shortfall equals required", () => {
  const mid = slot(build({ pool: [] }), WEEK, "09:30");
  assert.deepEqual([mid.suggested, mid.shortfall, mid.status], [0, 4, "shortfall"]);
});

test("no productivity: unknown slots, null counts, run flag, no capacity demand", () => {
  const r = build({ productivity: null });
  const mid = slot(r, WEEK, "09:30");
  assert.deepEqual([mid.required, mid.suggested, mid.shortfall, mid.status], [null, null, null, "unknown"]);
  assert.equal(r.flags.noProductivity, true);
  assert.equal(r.capacity.requiredH, 0);
  assert.equal(r.productivity, null);
});

test("flags and capacity are assembled", () => {
  const r = build();
  assert.equal(r.flags.noProductivity, false);
  assert.equal(r.capacity.requiredH, 5); // 5 slots x 4 cashiers x 0.25 h
  assert.equal(r.capacity.ordinaryCapH, 126);
  assert.equal(r.capacity.overtimeNeeded, false);
  assert.equal(r.days[0].dailyShortfall, false);
  assert.deepEqual(r.inputs.settings, settings);
  assert.equal(r.inputs.trendRatio, 1);
});

test("day metadata and forecast totals are carried over", () => {
  const d = build().days[0];
  assert.equal(d.fecha, WEEK);
  assert.equal(d.dayType, "weekday");
  assert.equal(d.noHistory, false);
  assert.equal(d.forecast.docs, 37.5);
  assert.deepEqual(d.forecast.peakSlots, ["09:00"]);
  assert.equal(build().days[6].dayType, "sunday");
  assert.equal(slot(build(), WEEK, "09:30").forecastDocs, 7.5);
});

test("slots start without override: final equals suggested, diff 0", () => {
  const mid = slot(build(), WEEK, "09:30");
  assert.deepEqual([mid.override, mid.final, mid.diff], [null, 3, 0]);
});

test("applyOverrides: final = override ?? suggested, diff = final - suggested", () => {
  const r = build();
  const out = applyOverrides(r.days, [
    { fecha: WEEK, franja: "09:30", headcount: 5 },
    { fecha: WEEK, franja: "09:00", headcount: 0 },
  ]);
  const find = (f) => out[0].slots.find((s) => s.franja === f);
  assert.deepEqual([find("09:30").override, find("09:30").final, find("09:30").diff], [5, 5, 2]);
  assert.deepEqual([find("09:00").override, find("09:00").final, find("09:00").diff], [0, 0, -3]); // 0 is a real override
  assert.deepEqual([find("09:15").override, find("09:15").final, find("09:15").diff], [null, 3, 0]);
});

test("overrides survive a recompute: same overrides over a new suggestion layer", () => {
  const overrides = [{ fecha: WEEK, franja: "09:30", headcount: 5 }];
  const before = applyOverrides(build({ pool: pool(2) }).days, overrides)[0].slots.find((s) => s.franja === "09:30");
  const after = applyOverrides(build({ pool: pool(10) }).days, overrides)[0].slots.find((s) => s.franja === "09:30");
  assert.deepEqual([before.suggested, before.override, before.final], [2, 5, 5]);
  assert.deepEqual([after.suggested, after.override, after.final], [4, 5, 5]);
});

test("override over an unknown suggestion keeps final = override and diff null", () => {
  const days = build({ productivity: null }).days;
  const s = applyOverrides(days, [{ fecha: WEEK, franja: "09:30", headcount: 2 }])[0].slots.find((x) => x.franja === "09:30");
  assert.deepEqual([s.suggested, s.final, s.diff], [null, 2, null]);
});

test("applyOverrides does not mutate its input and ignores unknown slots", () => {
  const days = build().days;
  const out = applyOverrides(days, [{ fecha: WEEK, franja: "23:45", headcount: 9 }, { fecha: "2030-01-01", franja: "09:00", headcount: 1 }]);
  assert.equal(days[0].slots.find((s) => s.franja === "09:30").override, null);
  assert.equal(out[0].slots.length, 5);
  assert.notEqual(out[0], days[0]);
});

test("productivity 0 raises the noProductivity flag", () => {
  const r = build({ productivity: 0 });
  assert.equal(r.flags.noProductivity, true);
  assert.equal(slot(r, WEEK, "09:30").status, "unknown");
});
