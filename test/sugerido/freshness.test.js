import test from "node:test";
import assert from "node:assert/strict";

import { computeFreshness } from "../../src/modules/sugerido/domain/freshness.js";

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
