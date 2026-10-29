import { addDays, mondayOf } from "./dates.js";

// Weeks a request may target, counted from the Monday of the current week.
export const MAX_WEEKS_BACK = 53; // backtesting against last year's same week
export const MAX_WEEKS_AHEAD = 12;

/** True when the Monday `weekStart` is inside the allowed window relative to `today` (Bogota date). */
export function isWeekInRange(weekStart, today) {
  const current = mondayOf(today);
  return weekStart >= addDays(current, -MAX_WEEKS_BACK * 7) && weekStart <= addDays(current, MAX_WEEKS_AHEAD * 7);
}
