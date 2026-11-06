import test from "node:test";
import assert from "node:assert/strict";

import { targetWeeks } from "../../src/modules/sugerido/domain/targetWeeks.js";

test("midweek: current and next Monday", () => {
  assert.deepEqual(targetWeeks(new Date("2026-11-04T12:00:00Z")), { current: "2026-11-02", next: "2026-11-09" });
});

test("Sunday night in Bogota still belongs to the week that is ending", () => {
  // 2026-11-09 03:59Z = Sunday 2026-11-08 22:59 in Bogota
  assert.deepEqual(targetWeeks(new Date("2026-11-09T03:59:00Z")), { current: "2026-11-02", next: "2026-11-09" });
});

test("Monday 00:00 in Bogota (05:00Z) rolls over to the new week", () => {
  assert.deepEqual(targetWeeks(new Date("2026-11-09T05:00:00Z")), { current: "2026-11-09", next: "2026-11-16" });
});

test("the scheduled 11:00Z run on a Monday targets that Monday and the next", () => {
  assert.deepEqual(targetWeeks(new Date("2026-11-09T11:00:00Z")), { current: "2026-11-09", next: "2026-11-16" });
});

test("crosses a year boundary", () => {
  assert.deepEqual(targetWeeks(new Date("2026-12-30T11:00:00Z")), { current: "2026-12-28", next: "2027-01-04" });
});
