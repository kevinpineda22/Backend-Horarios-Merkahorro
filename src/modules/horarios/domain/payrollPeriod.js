import { addDays, diffDays, isoDow, toEpochDay } from "../../sugerido/domain/dates.js";

/** First Monday of the 14-day payroll grid (W2). */
export const PAYROLL_ANCHOR = "2026-08-31";
export const DEFAULT_PERIOD_DAYS = 14;

const isDate = (value) => {
  try {
    toEpochDay(value);
    return true;
  } catch {
    return false;
  }
};

/** Why a [from, to] period is not a payroll cut, or null when it is valid. */
export function periodError(from, to) {
  if (!isDate(from) || !isDate(to)) return "invalid date";
  if (isoDow(from) !== 1) return "from must be a Monday";
  if (isoDow(to) !== 7) return "to must be a Sunday";
  const span = diffDays(to, from);
  if (span !== 6 && span !== 13) return "length must be 7 or 14 days";
  return null;
}

/** Monday-Sunday weeks of a valid period, in order. */
export function periodWeeks(from, to) {
  const weeks = [];
  for (let start = from; diffDays(to, start) >= 6; start = addDays(start, 7)) {
    weeks.push({ weekStart: start, weekEnd: addDays(start, 6) });
  }
  return weeks;
}

/**
 * Period shown when the caller sends none. Slice 2 passes `lastPaidEnd` (end of the newest
 * PAGADO cut) and the cut grid continues from the day after it; without cuts the 14-day grid
 * anchored at PAYROLL_ANCHOR gives the block that contains `today`.
 */
export function defaultPeriod({ today, lastPaidEnd = null }) {
  if (lastPaidEnd) {
    const from = addDays(lastPaidEnd, 1);
    return { from, to: addDays(from, DEFAULT_PERIOD_DAYS - 1) };
  }
  const block = Math.floor(diffDays(today, PAYROLL_ANCHOR) / DEFAULT_PERIOD_DAYS);
  const from = addDays(PAYROLL_ANCHOR, block * DEFAULT_PERIOD_DAYS);
  return { from, to: addDays(from, DEFAULT_PERIOD_DAYS - 1) };
}
