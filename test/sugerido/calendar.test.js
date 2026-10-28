import test from "node:test";
import assert from "node:assert/strict";

import { dayType, getHoliday, referenceDates } from "../../src/modules/sugerido/domain/calendar.js";

test("getHoliday resolves Colombian public holidays", () => {
  assert.ok(getHoliday("2026-12-25"));
  assert.ok(getHoliday("2026-01-01"));
  assert.equal(getHoliday("2026-10-28"), null);
});

test("getHoliday excludes non-national dates reported by date-holidays", () => {
  assert.equal(getHoliday("2026-04-05"), null); // Easter Sunday
  assert.equal(getHoliday("2026-07-13"), null); // Virgen de Chiquinquira
  assert.ok(getHoliday("2026-04-02")); // Holy Thursday
  assert.ok(getHoliday("2026-04-03")); // Good Friday
  assert.ok(getHoliday("2026-05-18")); // Ascension (Ley Emiliani)
  assert.ok(getHoliday("2026-06-08")); // Corpus Christi
  assert.ok(getHoliday("2026-06-15")); // Sagrado Corazon
});

test("dayType: Easter Sunday is a plain sunday", () => {
  assert.equal(dayType("2026-04-05"), "sunday");
});

test("dayType: holiday wins over Sunday, then Sunday, then weekday", () => {
  assert.equal(dayType("2022-12-25"), "holiday"); // Christmas on a Sunday
  assert.equal(dayType("2026-12-25"), "holiday");
  assert.equal(dayType("2026-10-25"), "sunday");
  assert.equal(dayType("2026-10-28"), "weekday");
});

test("weekday references: same ISODOW, non-holiday, newest first, strictly before dataAsOf", () => {
  // Target Wed 2026-10-28; dataAsOf Tue 10-27 -> latest candidate is Wed 10-21.
  const refs = referenceDates("2026-10-28", "2026-10-27", { count: 4 });
  assert.deepEqual(refs, ["2026-10-21", "2026-10-14", "2026-10-07", "2026-09-30"]);
});

test("dates on or after dataAsOf are never used (partial last day)", () => {
  // Target Wed 10-28 itself is the dataAsOf day: it must be excluded.
  const refs = referenceDates("2026-11-04", "2026-10-28", { count: 2 });
  assert.deepEqual(refs, ["2026-10-21", "2026-10-14"]);
});

test("weekday references skip holidays on the same weekday", () => {
  // Mon 2026-11-02 and Mon 2026-11-16 are holidays; target Mon 2026-11-23.
  const refs = referenceDates("2026-11-23", "2026-11-22", { count: 3 });
  assert.ok(!refs.includes("2026-11-16"));
  assert.ok(!refs.includes("2026-11-02"));
  assert.deepEqual(refs, ["2026-11-09", "2026-10-26", "2026-10-19"]);
});

test("sunday references are non-holiday Sundays only", () => {
  const refs = referenceDates("2026-11-08", "2026-11-07", { count: 3 });
  for (const d of refs) assert.equal(dayType(d), "sunday");
  assert.equal(refs[0], "2026-11-01");
});

test("holiday references are past holidays", () => {
  const refs = referenceDates("2026-12-25", "2026-12-20", { count: 3 });
  assert.equal(refs.length, 3);
  for (const d of refs) assert.equal(dayType(d), "holiday");
  assert.ok(refs.every((d) => d < "2026-12-20"));
});

test("isOpen predicate skips closed days while walking back", () => {
  const closed = new Set(["2026-10-21"]);
  const refs = referenceDates("2026-10-28", "2026-10-27", { count: 2, isOpen: (d) => !closed.has(d) });
  assert.deepEqual(refs, ["2026-10-14", "2026-10-07"]);
});

test("holiday references reach past the 120-day weekday lookback", () => {
  // San Jose (2026-03-23) is 272 days before dataAsOf: only the 730-day holiday walk finds it.
  const refs = referenceDates("2026-12-25", "2026-12-20", { count: 1, isOpen: (d) => d === "2026-03-23" });
  assert.deepEqual(refs, ["2026-03-23"]);
});

test("weekday references stop at the 120-day lookback", () => {
  const refs = referenceDates("2026-10-28", "2026-10-27", { count: 4, isOpen: (d) => d === "2026-04-01" });
  assert.deepEqual(refs, []);
});
