import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYROLL_ANCHOR,
  periodError,
  periodWeeks,
  defaultPeriod,
} from "../../src/modules/horarios/domain/payrollPeriod.js";

test("a period is valid only as 1 or 2 whole Monday-Sunday weeks", () => {
  assert.equal(periodError("2026-08-31", "2026-09-06"), null);
  assert.equal(periodError("2026-08-31", "2026-09-13"), null);
  assert.ok(periodError("2026-09-01", "2026-09-07"), "starts on Tuesday");
  assert.ok(periodError("2026-08-31", "2026-09-05"), "ends on Saturday");
  assert.ok(periodError("2026-08-31", "2026-09-20"), "three weeks");
  assert.ok(periodError("2026-09-13", "2026-08-31"), "reversed");
  assert.ok(periodError("2026-02-30", "2026-03-08"), "impossible date");
  assert.ok(periodError("nope", "2026-09-06"));
  assert.ok(periodError(undefined, undefined));
});

test("periodWeeks lists the Monday-Sunday weeks of the period", () => {
  assert.deepEqual(periodWeeks("2026-08-31", "2026-09-13"), [
    { weekStart: "2026-08-31", weekEnd: "2026-09-06" },
    { weekStart: "2026-09-07", weekEnd: "2026-09-13" },
  ]);
});

test("default period is the 14-day block containing today, anchored 2026-08-31", () => {
  assert.equal(PAYROLL_ANCHOR, "2026-08-31");
  assert.deepEqual(defaultPeriod({ today: "2026-08-31" }), { from: "2026-08-31", to: "2026-09-13" });
  assert.deepEqual(defaultPeriod({ today: "2026-09-13" }), { from: "2026-08-31", to: "2026-09-13" });
  assert.deepEqual(defaultPeriod({ today: "2026-09-14" }), { from: "2026-09-14", to: "2026-09-27" });
  assert.deepEqual(defaultPeriod({ today: "2026-11-05" }), { from: "2026-10-26", to: "2026-11-08" });
});

test("default period before the anchor walks back in 14-day blocks", () => {
  assert.deepEqual(defaultPeriod({ today: "2026-08-30" }), { from: "2026-08-17", to: "2026-08-30" });
});

test("slice-2 seam: a PAGADO cut end overrides the anchor rule (day after its end)", () => {
  assert.deepEqual(defaultPeriod({ today: "2026-11-05", lastPaidEnd: "2026-09-13" }), {
    from: "2026-09-14",
    to: "2026-09-27",
  });
});
