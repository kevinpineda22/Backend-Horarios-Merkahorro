import { parseNumeric } from "./numeric.js";

const TABLE = "sugerido_settings";
const SETTINGS_ID = 1;

// camelCase key -> column. Only these keys are ever written.
const COLUMNS = {
  ordinaryWeeklyHours: "ordinary_weekly_hours",
  overtimeWeeklyHours: "overtime_weekly_hours",
  dailyMaxHours: "daily_max_hours",
  utilization: "utilization",
  maxWorkingDaysPerWeek: "max_working_days_per_week",
  minCashiers: "min_cashiers",
  staleAfterDays: "stale_after_days",
  blockingAbsenceTypes: "blocking_absence_types",
};
const NUMERIC_KEYS = Object.keys(COLUMNS).filter((k) => k !== "blockingAbsenceTypes");

function toSettings(row) {
  const out = {};
  for (const [key, column] of Object.entries(COLUMNS)) {
    out[key] = NUMERIC_KEYS.includes(key) ? parseNumeric(row[column], column) : row[column];
  }
  return { ...out, updatedBy: row.updated_by ?? null, updatedAt: row.updated_at ?? null };
}

function unwrapRow({ data, error }) {
  if (error) throw error;
  if (!data) throw new Error("Sugerido settings row not found");
  return data;
}

/** Global settings row (id = 1). Supabase client and clock are injected. */
export function createSettingsRepo(client, { now = () => new Date() } = {}) {
  return {
    async getSettings() {
      return toSettings(unwrapRow(await client.from(TABLE).select("*").eq("id", SETTINGS_ID).maybeSingle()));
    },

    /** Partial update: only recognised keys with a defined value are written. */
    async updateSettings(patch, userId) {
      const row = {};
      for (const [key, column] of Object.entries(COLUMNS)) {
        if (patch[key] !== undefined) row[column] = patch[key];
      }
      if (Object.keys(row).length === 0) throw new Error("No settings to update");
      row.updated_by = userId;
      row.updated_at = now().toISOString();
      return toSettings(unwrapRow(await client.from(TABLE).update(row).eq("id", SETTINGS_ID).select().maybeSingle()));
    },
  };
}
