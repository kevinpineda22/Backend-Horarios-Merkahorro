import test from "node:test";
import assert from "node:assert/strict";

import { computeProductivity } from "../../src/modules/sugerido/domain/productivity.js";

const AS_OF = "2026-10-28";
const row = (fecha, docs, cajeras = 1, franja = "10:00") => ({ fecha, franja, docs, cajeras });
// n slots with docs 1..n, one cashier each.
const seq = (n) => Array.from({ length: n }, (_, i) => row("2026-10-20", i + 1));

test("productivity is the docs-weighted mean rate of the busiest 20% slots (n=10 -> top 2)", () => {
  // rates are docs*4/cajeras = 4*docs; top 2 are docs 10 and 9.
  const p = computeProductivity(seq(10), AS_OF);
  assert.equal(p, 38.1053); // (40*10 + 36*9) / 19
});

test("top bucket size uses ceil: n=11 -> top 3", () => {
  const p = computeProductivity(seq(11), AS_OF);
  assert.equal(p, 40.2667); // (44*11 + 40*10 + 36*9) / 30
});

test("n=5 -> top 1 slot only", () => {
  assert.equal(computeProductivity(seq(5), AS_OF), 20); // docs 5 -> rate 20
});

test("rate divides by distinct cashiers", () => {
  assert.equal(computeProductivity([row("2026-10-20", 10, 2)], AS_OF), 20); // 10*4/2
});

test("window: 8 weeks back inclusive, dataAsOf itself excluded", () => {
  assert.equal(computeProductivity([row("2026-09-02", 5)], AS_OF), 20); // exactly 56 days back
  assert.equal(computeProductivity([row("2026-09-01", 5)], AS_OF), null); // 57 days back
  assert.equal(computeProductivity([row("2026-10-28", 5)], AS_OF), null); // partial day
  assert.equal(computeProductivity([row("2026-10-27", 5)], AS_OF), 20);
});

test("null when there is no usable data", () => {
  assert.equal(computeProductivity([], AS_OF), null);
  assert.equal(computeProductivity([row("2026-10-20", 0)], AS_OF), null);
  assert.equal(computeProductivity([row("2026-10-20", 5, 0)], AS_OF), null);
});

test("rows with zero cashiers are skipped, others still count", () => {
  assert.equal(computeProductivity([row("2026-10-20", 99, 0), row("2026-10-20", 5, 1)], AS_OF), 20);
});

test("rejects non-finite input", () => {
  assert.throws(() => computeProductivity([row("2026-10-20", NaN)], AS_OF), /finite/);
});

test("the dataAsOf day is excluded even when it holds outlier rows (partial day), the day before counts", () => {
  const outliers = [row("2026-10-28", 5000, 1), row("2026-10-28", 4000, 1, "11:00")];
  assert.equal(computeProductivity([...seq(5), ...outliers], AS_OF), 20);
  assert.equal(computeProductivity([row("2026-10-27", 5000, 1)], AS_OF), 20000);
});
