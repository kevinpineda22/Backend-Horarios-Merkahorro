import test from "node:test";
import assert from "node:assert/strict";

import { computeFreshness } from "../../src/modules/sugerido/domain/freshness.js";
import { bogotaToday } from "../../src/modules/sugerido/domain/dates.js";

const TODAY = "2026-10-28";

test("exactly staleAfterDays old is not stale", () => {
  const r = computeFreshness({ dataAsOf: "2026-10-26", today: TODAY, staleAfterDays: 2 });
  assert.deepEqual(r, { dataAsOf: "2026-10-26", stale: false, notice: null });
});

test("one day past staleAfterDays is stale with a notice", () => {
  const r = computeFreshness({ dataAsOf: "2026-10-25", today: TODAY, staleAfterDays: 2 });
  assert.equal(r.stale, true);
  assert.equal(r.dataAsOf, "2026-10-25");
  assert.match(r.notice, /3 days/);
});

test("data from today is fresh, even with staleAfterDays 0", () => {
  assert.equal(computeFreshness({ dataAsOf: TODAY, today: TODAY, staleAfterDays: 0 }).stale, false);
  assert.equal(computeFreshness({ dataAsOf: "2026-10-27", today: TODAY, staleAfterDays: 0 }).stale, true);
});

test("no data (null dataAsOf) is stale with a notice", () => {
  const r = computeFreshness({ dataAsOf: null, today: TODAY, staleAfterDays: 2 });
  assert.equal(r.dataAsOf, null);
  assert.equal(r.stale, true);
  assert.match(r.notice, /no sales data/i);
});

test("future dataAsOf is not stale", () => {
  assert.equal(computeFreshness({ dataAsOf: "2026-10-30", today: TODAY, staleAfterDays: 2 }).stale, false);
});

test("read-time freshness uses the Bogota calendar date of the injected clock", () => {
  // 2026-10-29T03:30Z is still Oct 28 in Bogota (UTC-5), 2026-10-29T05:00Z is Oct 29.
  const lateNight = bogotaToday(new Date("2026-10-29T03:30:00Z"));
  assert.equal(computeFreshness({ dataAsOf: "2026-10-28", today: lateNight, staleAfterDays: 0 }).stale, false);
  const nextDay = bogotaToday(new Date("2026-10-29T05:00:00Z"));
  assert.equal(computeFreshness({ dataAsOf: "2026-10-28", today: nextDay, staleAfterDays: 0 }).stale, true);
});

test("the same stored dataAsOf becomes stale as the clock advances (computed, never persisted)", () => {
  const stored = Object.freeze({ dataAsOf: "2026-10-26", staleAfterDays: 1 });
  assert.equal(computeFreshness({ ...stored, today: "2026-10-27" }).stale, false);
  assert.equal(computeFreshness({ ...stored, today: "2026-10-28" }).stale, true);
});

test("notice names the age and the last data date; undefined dataAsOf counts as missing", () => {
  const r = computeFreshness({ dataAsOf: "2026-10-20", today: TODAY, staleAfterDays: 1 });
  assert.match(r.notice, /8 days/);
  assert.match(r.notice, /2026-10-20/);
  const missing = computeFreshness({ dataAsOf: undefined, today: TODAY, staleAfterDays: 1 });
  assert.deepEqual([missing.dataAsOf, missing.stale], [null, true]);
});
