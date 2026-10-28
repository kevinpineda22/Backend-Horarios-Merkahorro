import test from "node:test";
import assert from "node:assert/strict";

import { computeHeadcount } from "../../src/modules/sugerido/domain/headcount.js";

const settings = { utilization: 0.85, minCashiers: 1 };
const flat = (docs, labels) => labels.map((franja) => ({ franja, docs }));
const FIVE = ["09:00", "09:15", "09:30", "09:45", "10:00"];
const byFranja = (res, f) => res.find((s) => s.franja === f);

test("worked example: 30 docs/h, productivity 10, utilization 0.85 -> 4", () => {
  const res = computeHeadcount({ slots: flat(7.5, FIVE), productivity: 10, settings });
  const mid = byFranja(res, "09:30");
  assert.equal(mid.smoothedDocsPerHour, 30);
  assert.equal(mid.required, 4);
  assert.equal(mid.status, "ok");
});

test("smoothing: first and last open slot average only existing open neighbours", () => {
  const res = computeHeadcount({ slots: flat(7.5, FIVE), productivity: 10, settings });
  for (const f of ["09:00", "10:00"]) {
    assert.equal(byFranja(res, f).smoothedDocsPerHour, 30); // (7.5 + 7.5) / 2 * 4, not diluted by a phantom 0
    assert.equal(byFranja(res, f).required, 4); // not under-staffed (ceil(30 / 8.5) = 4)
  }
});

test("smoothing: an isolated open slot uses only itself", () => {
  const slots = [{ franja: "09:00", docs: 0 }, { franja: "09:15", docs: 9 }, { franja: "09:30", docs: 0 }];
  const res = computeHeadcount({ slots, productivity: 10, settings });
  assert.equal(byFranja(res, "09:15").smoothedDocsPerHour, 36); // 9 * 4, closed neighbours excluded
});

test("smoothing: day edges are not neighbours (00:00 and 23:45)", () => {
  const slots = [{ franja: "00:00", docs: 6 }, { franja: "23:45", docs: 6 }];
  const res = computeHeadcount({ slots, productivity: 10, settings });
  assert.equal(byFranja(res, "00:00").smoothedDocsPerHour, 24);
  assert.equal(byFranja(res, "23:45").smoothedDocsPerHour, 24);
});

test("float noise: 33.6 docs/h / (12 x 0.7) is exactly 4, not 5", () => {
  assert.ok(33.6 / (12 * 0.7) > 4); // the raw float division overshoots 4 by ~1e-15
  const res = computeHeadcount({ slots: flat(8.4, FIVE), productivity: 12, settings: { ...settings, utilization: 0.7 } });
  assert.equal(byFranja(res, "09:30").required, 4);
});

test("exact multiple does not round up (34 docs/h / 8.5 = 4)", () => {
  const res = computeHeadcount({ slots: flat(8.5, FIVE), productivity: 10, settings });
  assert.equal(byFranja(res, "09:30").required, 4);
});

test("just above the boundary rounds up (ceil, not round)", () => {
  const res = computeHeadcount({ slots: flat(8.51, FIVE), productivity: 10, settings });
  assert.equal(byFranja(res, "09:30").required, 5);
});

test("ceil, not round: 3.1 -> 4", () => {
  // 26.35 docs/h / 8.5 = 3.1
  const res = computeHeadcount({ slots: flat(26.35 / 4, FIVE), productivity: 10, settings });
  assert.equal(byFranja(res, "09:30").required, 4);
});

test("minCashiers floors an open slot", () => {
  const res = computeHeadcount({ slots: flat(0.1, FIVE), productivity: 10, settings: { ...settings, minCashiers: 2 } });
  assert.equal(byFranja(res, "09:30").required, 2);
});

test("minCashiers 0 still requires ceil for a busy slot", () => {
  const res = computeHeadcount({ slots: flat(0.1, FIVE), productivity: 10, settings: { ...settings, minCashiers: 0 } });
  assert.equal(byFranja(res, "09:30").required, 1);
});

test("closed slot (no forecast docs) requires 0 regardless of minCashiers", () => {
  const slots = [{ franja: "09:00", docs: 5 }, { franja: "09:15", docs: 0 }];
  const res = computeHeadcount({ slots, productivity: 10, settings: { ...settings, minCashiers: 2 } });
  assert.equal(byFranja(res, "09:15").required, 0);
  assert.equal(byFranja(res, "09:15").status, "closed");
});

test("null or zero productivity -> required null, status unknown, no division", () => {
  for (const productivity of [null, 0]) {
    const res = computeHeadcount({ slots: flat(7.5, FIVE), productivity, settings });
    assert.ok(res.every((s) => s.required === null && s.status === "unknown"));
  }
});

test("validates numbers at the boundary", () => {
  const slots = flat(5, FIVE);
  assert.throws(() => computeHeadcount({ slots, productivity: 10, settings: { ...settings, utilization: NaN } }), /utilization/);
  assert.throws(() => computeHeadcount({ slots, productivity: 10, settings: { ...settings, utilization: 0 } }), /utilization/);
  assert.throws(() => computeHeadcount({ slots, productivity: 10, settings: { ...settings, minCashiers: "2" } }), /minCashiers/);
  assert.throws(() => computeHeadcount({ slots, productivity: NaN, settings }), /productivity/);
  assert.throws(() => computeHeadcount({ slots, productivity: -1, settings }), /productivity/);
});
