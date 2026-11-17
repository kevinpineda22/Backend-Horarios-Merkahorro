import test from "node:test";
import assert from "node:assert/strict";

import { computeAccuracy, docsMetrics, hourlySeries, seriesMetrics } from "../../src/modules/sugerido/domain/accuracy.js";

const row = (franja, needed, system, published, forecastDocs = 10, actualDocs = 10, fecha = "2026-11-02") => ({ fecha, franja, needed, system, published, forecastDocs, actualDocs });

test("seriesMetrics: over / under cashier-hours are slot gaps times 0.25 h", () => {
  const rows = [row("08:00", 3, 5, 3), row("08:15", 3, 1, 3), row("08:30", 2, 2, 4)];
  const m = seriesMetrics(rows, "system");
  assert.equal(m.overHours, 0.5); // +2 slots * 0.25
  assert.equal(m.underHours, 0.5);
  assert.equal(m.neededHours, 2);
  assert.equal(m.hours, 2);
  assert.equal(m.exactRate, 0.3333);
  assert.equal(m.withinOneRate, 0.3333);
  assert.equal(m.wape, 0.5); // (2 + 2 + 0) / 8
  assert.equal(m.bias, 0);
  assert.equal(seriesMetrics(rows, "published").overHours, 0.5);
});

test("seriesMetrics: exact and within +-1 are measured over open slots only", () => {
  const rows = [
    row("08:00", 2, 2, 2), // exact
    row("08:15", 2, 3, 2), // within 1
    row("08:30", 2, 5, 2), // off
    row("22:00", 0, 0, 0, 0, 0), // closed in forecast and actual: excluded
  ];
  const m = seriesMetrics(rows, "system");
  assert.equal(m.openSlots, 3);
  assert.equal(m.exactRate, 0.3333);
  assert.equal(m.withinOneRate, 0.6667);
});

test("seriesMetrics: a slot open only in the forecast or only in the actual counts as open", () => {
  const rows = [row("08:00", 0, 1, 0, 5, 0), row("08:15", 1, 1, 1, 0, 5)];
  assert.equal(seriesMetrics(rows, "system").openSlots, 2);
});

test("seriesMetrics: null series -> null; nothing needed -> wape and bias null", () => {
  assert.equal(seriesMetrics([row("08:00", 1, null, 1)], "system"), null);
  assert.equal(seriesMetrics([], "published"), null);
  const m = seriesMetrics([row("08:00", 0, 2, 0, 0, 0)], "system");
  assert.equal(m.wape, null);
  assert.equal(m.bias, null);
  assert.equal(m.exactRate, null); // no open slot
});

test("seriesMetrics: bias is positive when overstaffed", () => {
  assert.equal(seriesMetrics([row("08:00", 2, 3, 3), row("08:15", 2, 3, 3)], "system").bias, 0.5);
});

test("docsMetrics: WAPE and bias of forecast vs actual docs", () => {
  const m = docsMetrics([row("08:00", 1, 1, 1, 12, 10), row("08:15", 1, 1, 1, 6, 10)]);
  assert.deepEqual(m, { wape: 0.3, bias: -0.1, forecast: 18, actual: 20 });
  assert.equal(docsMetrics([row("08:00", 0, 0, 0, 5, 0)]).wape, null);
});

test("hourlySeries: averages the four 15-minute slots of each hour, ordered by hour", () => {
  const rows = [row("09:00", 4, 2, 4), row("08:00", 2, 2, 2), row("08:15", 2, 2, 2), row("08:30", 2, 2, 2), row("08:45", 2, 2, 2)];
  assert.deepEqual(hourlySeries(rows), [
    { hour: 8, needed: 2, system: 2, published: 2 },
    { hour: 9, needed: 1, system: 0.5, published: 1 },
  ]);
});

test("hourlySeries: system is null when no row has it", () => {
  assert.equal(hourlySeries([row("08:00", 2, null, 2)])[0].system, null);
});

test("computeAccuracy: week summary, per-day breakdown ordered by date", () => {
  const rows = [row("08:00", 2, 3, 2, 10, 10, "2026-11-03"), row("08:00", 2, 2, 1, 10, 10, "2026-11-02")];
  const out = computeAccuracy(rows);
  assert.deepEqual(out.days.map((d) => d.fecha), ["2026-11-02", "2026-11-03"]);
  assert.equal(out.summary.system.overHours, 0.25);
  assert.equal(out.summary.published.underHours, 0.25);
  assert.equal(out.days[0].system.overHours, 0);
  assert.equal(out.days[1].system.overHours, 0.25);
  assert.equal(out.days[0].hours.length, 1);
});

test("computeAccuracy: no system values -> summary.system null, published still measured", () => {
  const out = computeAccuracy([row("08:00", 2, null, 3)]);
  assert.equal(out.summary.system, null);
  assert.equal(out.summary.published.overHours, 0.25);
});
