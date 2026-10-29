import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsRepo } from "../../src/modules/sugerido/repositories/settings.supabase.js";
import { fakeSupabase, has } from "./helpers.js";

const ROW = {
  id: 1,
  ordinary_weekly_hours: "42",
  overtime_weekly_hours: "12",
  daily_max_hours: "10",
  utilization: "0.85",
  max_working_days_per_week: 6,
  min_cashiers: 1,
  stale_after_days: 1,
  blocking_absence_types: ["Vacaciones", "Estudio"],
  updated_by: "u1",
  updated_at: "2026-10-01T00:00:00Z",
};
const ok = (data) => ({ data, error: null });

test("getSettings parses numeric strings to numbers and returns camelCase", async () => {
  const { client, log } = fakeSupabase({ tables: { sugerido_settings: ok(ROW) } });
  const s = await createSettingsRepo(client).getSettings();
  assert.deepEqual(s, {
    ordinaryWeeklyHours: 42,
    overtimeWeeklyHours: 12,
    dailyMaxHours: 10,
    utilization: 0.85,
    maxWorkingDaysPerWeek: 6,
    minCashiers: 1,
    staleAfterDays: 1,
    blockingAbsenceTypes: ["Vacaciones", "Estudio"],
    updatedBy: "u1",
    updatedAt: "2026-10-01T00:00:00Z",
  });
  assert.equal(typeof s.utilization, "number");
  assert.ok(has(log, "from", "sugerido_settings"));
  assert.ok(has(log, "eq", "id", 1));
  assert.ok(log.some((c) => c[0] === "maybeSingle"));
});

test("getSettings fails on non-numeric/blank values, missing row and db error", async () => {
  for (const bad of ["abc", "", null, "Infinity"]) {
    const { client } = fakeSupabase({ tables: { sugerido_settings: ok({ ...ROW, utilization: bad }) } });
    await assert.rejects(createSettingsRepo(client).getSettings(), /utilization/, String(bad));
  }
  const missing = fakeSupabase({ tables: { sugerido_settings: ok(null) } });
  await assert.rejects(createSettingsRepo(missing.client).getSettings(), /not found/i);
  const failing = fakeSupabase({ tables: { sugerido_settings: { data: null, error: new Error("down") } } });
  await assert.rejects(createSettingsRepo(failing.client).getSettings(), /down/);
});

test("updateSettings writes only provided keys (snake_case) plus audit, returns parsed row", async () => {
  const { client, log } = fakeSupabase({ tables: { sugerido_settings: ok({ ...ROW, utilization: "0.8" }) } });
  const repo = createSettingsRepo(client, { now: () => new Date("2026-10-29T12:00:00Z") });
  const out = await repo.updateSettings({ utilization: 0.8, blockingAbsenceTypes: ["Estudio"], bogus: 1, minCashiers: undefined }, "user-9");
  assert.ok(
    has(log, "update", {
      utilization: 0.8,
      blocking_absence_types: ["Estudio"],
      updated_by: "user-9",
      updated_at: "2026-10-29T12:00:00.000Z",
    }),
  );
  assert.ok(has(log, "eq", "id", 1));
  assert.equal(out.utilization, 0.8);
});

test("updateSettings with no recognised keys does not write; missing row errors", async () => {
  const { client, log } = fakeSupabase();
  await assert.rejects(createSettingsRepo(client).updateSettings({ bogus: 1 }, "u"), /no settings/i);
  assert.equal(log.length, 0);
  const none = fakeSupabase({ tables: { sugerido_settings: ok(null) } });
  await assert.rejects(createSettingsRepo(none.client).updateSettings({ minCashiers: 2 }, "u"), /not found/i);
});
