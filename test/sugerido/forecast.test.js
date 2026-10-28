import test from "node:test";
import assert from "node:assert/strict";

import { clampTrend, computeTrend, forecastDay, forecastWeek } from "../../src/modules/sugerido/domain/forecast.js";
import { addDays } from "../../src/modules/sugerido/domain/dates.js";

// Fixture builder: history = { "YYYY-MM-DD": { "HH:MM": docs } }; daily is derived.
function build(history) {
  const slots = {};
  const daily = {};
  for (const [fecha, bySlot] of Object.entries(history)) {
    slots[fecha] = {};
    daily[fecha] = 0;
    for (const [franja, docs] of Object.entries(bySlot)) {
      slots[fecha][franja] = { docs, venta: docs * 1000 };
      daily[fecha] += docs;
    }
  }
  return { slots, daily };
}

test("clampTrend bounds the ratio to [0.7, 1.3]", () => {
  assert.equal(clampTrend(0.1), 0.7);
  assert.equal(clampTrend(5), 1.3);
  assert.equal(clampTrend(1.1), 1.1);
  assert.equal(clampTrend(NaN), 1);
});

test("computeTrend compares last 28 days against the same 28 days a year earlier", () => {
  const daily = {};
  for (let i = 1; i <= 28; i += 1) {
    daily[addDays("2026-10-28", -i)] = 120; // recent window (strictly before dataAsOf)
    daily[addDays("2026-10-28", -i - 364)] = 100;
  }
  assert.equal(computeTrend(daily, "2026-10-28"), 1.2);
});

test("computeTrend window is exactly 28 days and excludes the dataAsOf day", () => {
  const daily = {};
  for (let i = 1; i <= 28; i += 1) {
    daily[addDays("2026-10-28", -i)] = 120;
    daily[addDays("2026-10-28", -i - 364)] = 100;
  }
  // Out-of-window entries on both sides: the dataAsOf day (i = 0) and day 29.
  for (const i of [0, 29]) {
    daily[addDays("2026-10-28", -i)] = 5000;
    daily[addDays("2026-10-28", -i - 364)] = 5000;
  }
  assert.equal(computeTrend(daily, "2026-10-28"), 1.2);
});

test("computeTrend returns 1 without a prior-year base and clamps extremes", () => {
  assert.equal(computeTrend({ "2026-10-27": 50 }, "2026-10-28"), 1);
  const daily = { "2026-10-27": 1000, [addDays("2026-10-27", -364)]: 10 };
  assert.equal(computeTrend(daily, "2026-10-28"), 1.3);
});

test("forecastDay blends A (mean of last 4 same-type days) and B (364d back x trend) as (A+B)/2", () => {
  // Target Wed 2026-11-04; dataAsOf 2026-11-02. Refs: 10-28, 10-21, 10-14, 10-07.
  const history = {
    "2026-10-28": { "08:00": 10 },
    "2026-10-21": { "08:00": 20 },
    "2026-10-14": { "08:00": 30 },
    "2026-10-07": { "08:00": 40 },
    "2025-11-05": { "08:00": 50 }, // target - 364
  };
  const { slots, daily } = build(history);
  const day = forecastDay({ fecha: "2026-11-04", dataAsOf: "2026-11-02", slots, daily, trendRatio: 1 });
  const slot = day.slots.find((s) => s.franja === "08:00");
  // A = 25, B = 50 * 1 -> 37.5
  assert.equal(slot.docs, 37.5);
  assert.equal(slot.venta, 37500);
  assert.equal(day.method, "blend");
  assert.equal(day.noHistory, false);
  assert.equal(day.lowHistory, false);
  assert.deepEqual(day.inputs.referenceDates, ["2026-10-28", "2026-10-21", "2026-10-14", "2026-10-07"]);
  assert.equal(day.inputs.yearAgoDate, "2025-11-05");
});

test("B is scaled by the trend ratio", () => {
  const { slots, daily } = build({
    "2026-10-28": { "08:00": 20 },
    "2025-11-05": { "08:00": 20 },
  });
  const day = forecastDay({ fecha: "2026-11-04", dataAsOf: "2026-11-02", slots, daily, trendRatio: 1.3 });
  // A = 20, B = 26 -> 23
  assert.equal(day.slots[0].docs, 23);
});

test("only A available: uses A and records method; only B: uses B", () => {
  const onlyA = build({ "2026-10-28": { "08:00": 12 }, "2026-10-21": { "08:00": 8 } });
  const dayA = forecastDay({ fecha: "2026-11-04", dataAsOf: "2026-11-02", ...onlyA, trendRatio: 1 });
  assert.equal(dayA.slots[0].docs, 10);
  assert.equal(dayA.method, "sameDayType");

  const onlyB = build({ "2025-11-05": { "08:00": 40 } });
  const dayB = forecastDay({ fecha: "2026-11-04", dataAsOf: "2026-11-02", ...onlyB, trendRatio: 1.1 });
  assert.equal(dayB.slots[0].docs, 44);
  assert.equal(dayB.method, "yearAgo");
  assert.equal(dayB.lowHistory, true);
  // No reference samples, so the year-ago input must be explicit rather than looking empty.
  assert.equal(dayB.inputs.samples, 0);
  assert.equal(dayB.inputs.yearAgoUsed, true);
  assert.equal(dayA.inputs.yearAgoUsed, false);
});

test("year-ago date must be strictly before dataAsOf (partial day never used)", () => {
  // Target Wed 2026-11-04 -> year-ago 2025-11-05, which is exactly the dataAsOf day.
  const { slots, daily } = build({ "2025-11-05": { "08:00": 40 } });
  const day = forecastDay({ fecha: "2026-11-04", dataAsOf: "2025-11-05", slots, daily, trendRatio: 1 });
  assert.equal(day.noHistory, true);
  assert.equal(day.inputs.yearAgoUsed, false);
  assert.equal(day.inputs.yearAgoDate, null);
});

test("year-ago holiday is not used for a weekday target (day types differ)", () => {
  // Mon 2026-12-07 is a weekday; its year-ago date Mon 2025-12-08 was a holiday.
  const { slots, daily } = build({
    "2025-12-08": { "08:00": 100 },
    "2026-11-30": { "08:00": 10 },
  });
  const day = forecastDay({ fecha: "2026-12-07", dataAsOf: "2026-12-06", slots, daily, trendRatio: 1 });
  assert.equal(day.dayType, "weekday");
  assert.equal(day.method, "sameDayType");
  assert.equal(day.inputs.yearAgoDate, null);
  assert.equal(day.slots[0].docs, 10);
});

test("holiday forecast uses a holiday reference older than 120 days", () => {
  const { slots, daily } = build({ "2026-03-23": { "10:00": 8 } }); // San Jose, 272 days back
  const day = forecastDay({ fecha: "2026-12-25", dataAsOf: "2026-12-20", slots, daily, trendRatio: 1 });
  assert.deepEqual(day.inputs.referenceDates, ["2026-03-23"]);
  assert.equal(day.slots[0].docs, 8);
});

test("missing slot counts as 0 on an open reference day", () => {
  const { slots, daily } = build({
    "2026-10-28": { "08:00": 10, "08:15": 10 },
    "2026-10-21": { "08:00": 10 }, // open (has sales) but no 08:15 sale
  });
  const day = forecastDay({ fecha: "2026-11-04", dataAsOf: "2026-11-02", slots, daily, trendRatio: 1 });
  assert.equal(day.slots.find((s) => s.franja === "08:15").docs, 5);
  assert.equal(day.inputs.referenceDates.length, 2);
});

test("a closed day (no sales at all) is excluded, not averaged as zero", () => {
  const { slots, daily } = build({
    "2026-10-28": { "08:00": 10 },
    "2026-10-14": { "08:00": 30 },
  }); // 10-21 has no rows -> sede closed
  const day = forecastDay({ fecha: "2026-11-04", dataAsOf: "2026-11-02", slots, daily, trendRatio: 1 });
  assert.equal(day.slots[0].docs, 20);
  assert.ok(!day.inputs.referenceDates.includes("2026-10-21"));
});

test("noHistory: zero samples gives zeros and the flag, never invented values", () => {
  const day = forecastDay({ fecha: "2026-11-04", dataAsOf: "2026-11-02", slots: {}, daily: {}, trendRatio: 1 });
  assert.equal(day.noHistory, true);
  assert.equal(day.lowHistory, false);
  assert.deepEqual(day.slots, []);
  assert.equal(day.totals.docs, 0);
  assert.equal(day.method, "none");
});

test("lowHistory: a single sample is used and listed", () => {
  const { slots, daily } = build({ "2026-10-28": { "08:00": 7 } });
  const day = forecastDay({ fecha: "2026-11-04", dataAsOf: "2026-11-02", slots, daily, trendRatio: 1 });
  assert.equal(day.lowHistory, true);
  assert.equal(day.noHistory, false);
  assert.deepEqual(day.inputs.referenceDates, ["2026-10-28"]);
  assert.equal(day.slots[0].docs, 7);
});

test("partial data day (>= dataAsOf) never feeds the forecast", () => {
  const { slots, daily } = build({
    "2026-11-02": { "08:00": 999 }, // dataAsOf day, partial
    "2026-10-26": { "08:00": 10 },
  });
  const day = forecastDay({ fecha: "2026-11-09", dataAsOf: "2026-11-02", slots, daily, trendRatio: 1 });
  assert.deepEqual(day.inputs.referenceDates, ["2026-10-26"]);
  assert.equal(day.slots[0].docs, 10);
});

test("holiday target draws only from past holidays", () => {
  const { slots, daily } = build({
    "2025-12-25": { "10:00": 6 },
    "2026-11-02": { "10:00": 14 }, // holiday (All Saints moved)
    "2026-10-28": { "10:00": 100 }, // regular weekday, must be ignored
  });
  const day = forecastDay({ fecha: "2026-12-25", dataAsOf: "2026-12-20", slots, daily, trendRatio: 1 });
  assert.equal(day.dayType, "holiday");
  assert.ok(day.holidayName);
  assert.ok(!day.inputs.referenceDates.includes("2026-10-28"));
  assert.deepEqual(day.inputs.referenceDates, ["2026-11-02", "2025-12-25"]);
  assert.equal(day.slots[0].docs, 10); // mean of 14 and 6
});

test("day totals: docs, venta, avgTicket and peak slots", () => {
  const { slots, daily } = build({
    "2026-10-28": { "08:00": 5, "08:15": 20, "08:30": 10, "08:45": 15 },
  });
  const day = forecastDay({ fecha: "2026-11-04", dataAsOf: "2026-11-02", slots, daily, trendRatio: 1 });
  assert.equal(day.totals.docs, 50);
  assert.equal(day.totals.venta, 50000);
  assert.equal(day.totals.avgTicket, 1000);
  assert.deepEqual(day.totals.peakSlots, ["08:15", "08:45", "08:30"]);
});

test("forecastWeek returns 7 days plus aggregated inputs", () => {
  const { slots, daily } = build({ "2026-10-28": { "08:00": 10 } });
  const week = forecastWeek({ weekStart: "2026-11-02", dataAsOf: "2026-11-02", slots, daily });
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0].fecha, "2026-11-02");
  assert.equal(week.inputs.trendRatio, 1);
  assert.deepEqual(Object.keys(week.inputs.referenceDates).length, 7);
});
