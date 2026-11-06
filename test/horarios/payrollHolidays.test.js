import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getHoliday } from "../../src/modules/sugerido/domain/calendar.js";
import { addDays } from "../../src/modules/sugerido/domain/dates.js";

const old = JSON.parse(readFileSync(new URL("./fixtures/festivos2026.json", import.meta.url), "utf8"));

test("the old scheduler's 2026 festivos table has 18 dates", () => {
  assert.equal(old.dates.length, 18);
  assert.deepEqual([...old.dates].sort(), old.dates);
});

test("calendar.js getHoliday over 2026 returns exactly the old festivos", () => {
  const found = [];
  for (let d = "2026-01-01"; d <= "2026-12-31"; d = addDays(d, 1)) {
    if (getHoliday(d)) found.push(d);
  }
  assert.deepEqual(found, old.dates);
});
