import Holidays from "date-holidays";

import { addDays, isoDow, toEpochDay } from "./dates.js";

const co = new Holidays("CO");
// Holidays are sparse, so they need a longer walk; regular days keep references recent.
export const RECENT_LOOKBACK_DAYS = 120;
export const HOLIDAY_LOOKBACK_DAYS = 730;

// date-holidays lists these as "public" for CO, but they are not national paid holidays.
const NOT_NATIONAL = new Set(["pascua", "la virgen de chiquinquirá"]);

const holidayCache = new Map();

/** Name of the Colombian national holiday on `fecha`, or null. Memoized per date. */
export function getHoliday(fecha) {
  const key = String(fecha);
  if (holidayCache.has(key)) return holidayCache.get(key);
  const [y, m, d] = key.split("-").map(Number);
  toEpochDay(key); // validates the format
  // Noon local time keeps the lookup stable regardless of the process timezone.
  const hits = co.isHoliday(new Date(y, m - 1, d, 12));
  const pub = Array.isArray(hits)
    ? hits.find((h) => h.type === "public" && !NOT_NATIONAL.has(h.name.toLowerCase()))
    : null;
  const name = pub ? pub.name : null;
  holidayCache.set(key, name);
  return name;
}

/** 'holiday' wins over 'sunday'; everything else is 'weekday'. */
export function dayType(fecha) {
  if (getHoliday(fecha)) return "holiday";
  return isoDow(fecha) === 7 ? "sunday" : "weekday";
}

/**
 * Past dates comparable to `target`, newest first, anchored to the TARGET's day type:
 * holiday -> holidays; sunday -> non-holiday Sundays; weekday -> same ISODOW, non-holiday.
 * Only dates strictly before `dataAsOf` (its last day may be partial) and before `target`.
 * `isOpen` lets the caller skip days the sede did not trade.
 */
export function referenceDates(target, dataAsOf, { count = 4, isOpen = () => true } = {}) {
  const type = dayType(target);
  const dow = isoDow(target);
  const out = [];
  let cursor = addDays(dataAsOf < target ? dataAsOf : target, -1);
  const lookback = type === "holiday" ? HOLIDAY_LOOKBACK_DAYS : RECENT_LOOKBACK_DAYS;
  for (let i = 0; i < lookback && out.length < count; i += 1, cursor = addDays(cursor, -1)) {
    if (dayType(cursor) !== type) continue;
    if (type === "weekday" && isoDow(cursor) !== dow) continue;
    if (isOpen(cursor)) out.push(cursor);
  }
  return out;
}
