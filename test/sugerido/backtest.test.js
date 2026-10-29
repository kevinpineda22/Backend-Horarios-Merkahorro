import test from "node:test";
import assert from "node:assert/strict";

import { aggregateToHour, wape, summarize, backtestWeek } from "../../src/modules/sugerido/domain/backtest.js";
import { forecastWeek } from "../../src/modules/sugerido/domain/forecast.js";
import { addDays, weekDates } from "../../src/modules/sugerido/domain/dates.js";

test("aggregateToHour sums the 15-minute slots of each hour per date", () => {
  const out = aggregateToHour({
    "2026-03-02": { "08:00": { docs: 1 }, "08:15": { docs: 2 }, "08:45": { docs: 3 }, "09:00": { docs: 4 } },
    "2026-03-03": { "08:30": { docs: 10 } },
  });
  assert.deepEqual(out, [
    { fecha: "2026-03-02", hour: 8, docs: 6 },
    { fecha: "2026-03-02", hour: 9, docs: 4 },
    { fecha: "2026-03-03", hour: 8, docs: 10 },
  ]);
  assert.deepEqual(aggregateToHour({}), []);
});

test("wape: perfect, symmetric errors, zeros and empty", () => {
  assert.equal(wape([{ forecast: 5, actual: 5 }, { forecast: 3, actual: 3 }]), 0);
  assert.equal(wape([{ forecast: 12, actual: 10 }, { forecast: 8, actual: 10 }]), 0.2);
  assert.equal(wape([{ forecast: 4, actual: 0 }, { forecast: 6, actual: 10 }]), 0.8);
  assert.equal(wape([{ forecast: 5, actual: 0 }]), null);
  assert.equal(wape([]), null);
});

const row = (o) => ({ sede: "a", weekday: 1, dayType: "weekday", hour: 8, week: "w1", forecast: 0, actual: 0, ...o });

test("summarize groups WAPE and bias by each key plus overall", () => {
  const rows = [
    row({ sede: "a", weekday: 6, forecast: 12, actual: 10 }),
    row({ sede: "a", weekday: 1, forecast: 8, actual: 10 }),
    row({ sede: "b", weekday: 6, forecast: 10, actual: 10 }),
  ];
  const s = summarize(rows, ["sede", "weekday"]);
  assert.equal(s.overall.n, 3);
  assert.equal(s.overall.actual, 30);
  assert.ok(Math.abs(s.overall.wape - 4 / 30) < 1e-12);
  assert.equal(s.overall.bias, 0); // (12+8+10-30)/30
  assert.deepEqual(s.by.sede.map((g) => g.group), ["a", "b"]);
  assert.equal(s.by.sede[0].wape, 0.2);
  assert.equal(s.by.sede[1].wape, 0);
  assert.deepEqual(s.by.weekday.map((g) => g.group), [1, 6]);
  assert.equal(s.by.weekday[1].n, 2);
  assert.ok(Math.abs(s.by.weekday[1].bias - 2 / 20) < 1e-12);
});

test("summarize bias keeps the sign and a zero-actual group reports null", () => {
  const s = summarize([row({ forecast: 3, actual: 10 }), row({ sede: "z", forecast: 2, actual: 0 })], ["sede"]);
  assert.equal(s.by.sede[0].bias, -0.7);
  assert.equal(s.by.sede[1].wape, null);
  assert.equal(s.by.sede[1].bias, null);
  assert.deepEqual(summarize([], ["sede"]).overall, { wape: null, bias: null, n: 0, actual: 0, forecast: 0 });
});

// History: 6 weeks of identical Mondays..Sundays (weekday pattern) before the target week.
const WEEK = "2026-03-09"; // Monday
const buildHistory = (levelByWeek) => {
  const slots = {};
  const daily = {};
  for (const [wk, level] of Object.entries(levelByWeek)) {
    for (const f of weekDates(wk)) {
      slots[f] = { "08:00": { docs: level, venta: level * 10 }, "08:15": { docs: level, venta: level * 10 } };
      daily[f] = level * 2;
    }
  }
  return { slots, daily };
};
const base = { "2026-01-26": 10, "2026-02-02": 10, "2026-02-09": 10, "2026-02-16": 10, "2026-02-23": 10, "2026-03-02": 10 };

test("backtestWeek compares the hourly forecast with the actuals of that week", () => {
  const history = buildHistory({ ...base, [WEEK]: 12 });
  const rows = backtestWeek({ history, weekStart: WEEK });
  const mon = rows.find((r) => r.fecha === WEEK && r.hour === 8);
  assert.equal(mon.forecast, 20); // two slots of 10 docs
  assert.equal(mon.actual, 24);
  assert.equal(mon.weekday, 1);
  assert.equal(mon.dayType, "weekday");
  assert.equal(mon.week, WEEK);
  assert.equal(rows.filter((r) => r.hour === 8).length, 7);
});

test("backtestWeek uses the same forecast model as the service on the pre-week history only", () => {
  const history = buildHistory({ ...base, [WEEK]: 12 });
  const rows = backtestWeek({ history, weekStart: WEEK });
  const pre = buildHistory(base);
  const direct = forecastWeek({ weekStart: WEEK, dataAsOf: addDays(WEEK, -1), slots: pre.slots, daily: pre.daily });
  for (const d of direct.days) {
    const expected = d.slots.reduce((s, x) => s + x.docs, 0);
    const got = rows.filter((r) => r.fecha === d.fecha).reduce((s, r) => s + r.forecast, 0);
    assert.ok(Math.abs(got - expected) < 1e-9, d.fecha);
  }
});

test("backtestWeek never leaks the target week or later into the forecast", () => {
  const a = backtestWeek({ history: buildHistory({ ...base, [WEEK]: 12 }), weekStart: WEEK });
  const b = backtestWeek({ history: buildHistory({ ...base, [WEEK]: 12, "2026-03-16": 500, "2026-03-23": 500 }), weekStart: WEEK });
  assert.deepEqual(b.map((r) => r.forecast), a.map((r) => r.forecast));
  // Changing the target week changes actuals only.
  const c = backtestWeek({ history: buildHistory({ ...base, [WEEK]: 99 }), weekStart: WEEK });
  assert.deepEqual(c.map((r) => r.forecast), a.map((r) => r.forecast));
  assert.notDeepEqual(c.map((r) => r.actual), a.map((r) => r.actual));
});

// The weekday references are always 7, 14, ... days back, so the only path for a leak is the
// 28-day trend, which is active only with a year of history. Without it, a leak is invisible.
test("backtestWeek never leaks the target week into the trend (year-ago history present)", () => {
  const yearAgo = {};
  for (let i = 0; i < 10; i++) yearAgo[addDays("2025-02-03", i * 7)] = 10;
  const withWeek = (level) => buildHistory({ ...yearAgo, ...base, [WEEK]: level });
  const a = backtestWeek({ history: withWeek(12), weekStart: WEEK });
  const c = backtestWeek({ history: withWeek(400), weekStart: WEEK });
  assert.deepEqual(c.map((r) => r.forecast), a.map((r) => r.forecast));
  // Guard against a vacuous test: the trend must really be in play with this fixture.
  const pre = buildHistory({ ...yearAgo, ...base });
  const direct = forecastWeek({ weekStart: WEEK, dataAsOf: addDays(WEEK, -1), slots: pre.slots, daily: pre.daily });
  assert.ok(direct.days.some((d) => d.inputs?.yearAgoUsed), "fixture must activate the year-ago trend");
});

test("backtestWeek with no prior history forecasts zero against real actuals", () => {
  const rows = backtestWeek({ history: buildHistory({ [WEEK]: 5 }), weekStart: WEEK });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.forecast === 0 && r.actual === 10));
});
