import test from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  bogotaToday,
  diffDays,
  isoDow,
  mondayOf,
  normalizeFranja,
  slotIndex,
  slotLabel,
  weekDates,
} from "../../src/modules/sugerido/domain/dates.js";

test("addDays crosses month, year and leap boundaries", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("isoDow: Monday=1 .. Sunday=7", () => {
  assert.equal(isoDow("2026-10-26"), 1);
  assert.equal(isoDow("2026-10-28"), 3);
  assert.equal(isoDow("2026-11-01"), 7);
  assert.equal(isoDow("1970-01-01"), 4);
});

test("diffDays and mondayOf", () => {
  assert.equal(diffDays("2026-10-28", "2026-10-21"), 7);
  assert.equal(diffDays("2026-10-21", "2026-10-28"), -7);
  assert.equal(mondayOf("2026-11-01"), "2026-10-26");
  assert.equal(mondayOf("2026-10-26"), "2026-10-26");
});

test("weekDates returns 7 consecutive dates and rejects non-Monday", () => {
  assert.deepEqual(weekDates("2026-10-26"), [
    "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01",
  ]);
  assert.throws(() => weekDates("2026-10-27"), /Monday/);
});

test("invalid date strings are rejected", () => {
  assert.throws(() => addDays("2026-02-30", 1), /Invalid date/);
  assert.throws(() => addDays("26-02-01", 1), /Invalid date/);
});

test("bogotaToday uses UTC-5 with an injected clock", () => {
  assert.equal(bogotaToday(new Date("2026-10-28T03:00:00Z")), "2026-10-27");
  assert.equal(bogotaToday(new Date("2026-10-28T05:00:00Z")), "2026-10-28");
  // Exact boundary: 04:59Z is still the previous day in Bogota, 05:00Z is midnight.
  assert.equal(bogotaToday(new Date("2026-10-28T04:59:00Z")), "2026-10-27");
  assert.equal(bogotaToday(new Date("2026-10-28T05:00:00Z")), "2026-10-28");
});

test("slot helpers round-trip 15-minute labels", () => {
  assert.equal(slotIndex("00:00"), 0);
  assert.equal(slotIndex("08:15:00"), 33);
  assert.equal(slotLabel(33), "08:15");
  assert.equal(normalizeFranja("08:15:00"), "08:15");
  assert.throws(() => slotIndex("08:10"), /Invalid slot/);
  assert.throws(() => slotIndex("24:00"), /Invalid slot/);
  assert.equal(slotIndex("23:45"), 95);
});
