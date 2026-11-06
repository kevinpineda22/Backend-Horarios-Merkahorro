import { addDays, bogotaToday, mondayOf } from "./dates.js";

/**
 * Weeks the daily recalculation covers: the Monday of the current week and of the next one,
 * both by the Bogota calendar (UTC-5, no DST). The clock is injected for deterministic tests.
 */
export function targetWeeks(now = new Date()) {
  const current = mondayOf(bogotaToday(now));
  return { current, next: addDays(current, 7) };
}
