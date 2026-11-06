import { addDays, diffDays } from "../../sugerido/domain/dates.js";
import { spanMinutes } from "./weekPayload.js";
import { workedIntervals } from "./weekRules.js";

/**
 * Payroll novelties engine (pure). Port of the old scheduler's labor-engine.calculateWeek and
 * reports.calculateEmployeeRow, validated against a golden fixture (payrollParity.json).
 *
 * Rows are camelCase: { cedula, sedeId, fecha, tipo, startTime, endTime, breakMinutes } and belong to
 * ONE cedula (every sede, every tipo). Only TRABAJO rows work. Times are Bogota wall clock.
 */

export const NIGHT_START_MINUTE = 19 * 60;
export const NIGHT_END_MINUTE = 6 * 60;
export const ORDINARY_WEEK_MINUTES = 42 * 60;
export const PAYROLL_ENGINE_VERSION = "1";

const DAY = 1440;
const WEEK = 7 * DAY;

export const hours = (minutes) => Math.round((Number(minutes || 0) / 60) * 100) / 100;
export const roundHours = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

/**
 * Classifies every worked minute of the Monday-Sunday week starting at `weekStart`.
 * `holidays` is an injected Set of 'YYYY-MM-DD' dates. Overlapping minutes count once.
 */
export function weekMinuteBuckets(rows, weekStart, holidays) {
  const occupied = new Uint8Array(WEEK);
  let hasOverlap = false;
  for (const row of rows) {
    if (row.tipo !== "TRABAJO" || !row.startTime || !row.endTime) continue;
    const span = spanMinutes(row.startTime, row.endTime);
    const breakMinutes = Math.min(Number(row.breakMinutes || 0), span);
    for (const [from, to] of workedIntervals({ ...row, breakMinutes }, weekStart)) {
      for (let m = from; m < to; m += 1) {
        if (occupied[m]) hasOverlap = true;
        else occupied[m] = 1;
      }
    }
  }

  const isHoliday = Array.from({ length: 7 }, (_, d) => holidays.has(addDays(weekStart, d)));
  const buckets = {
    total: 0,
    ordinaryDay: 0,
    ordinaryNight: 0,
    extraDay: 0,
    extraNight: 0,
    sunday: 0,
    festive: 0,
    sundayFestive: 0,
    hasOverlap,
  };
  let count = 0;
  for (let m = 0; m < WEEK; m += 1) {
    if (!occupied[m]) continue;
    count += 1;
    const day = Math.floor(m / DAY);
    const mod = m % DAY;
    const night = mod >= NIGHT_START_MINUTE || mod < NIGHT_END_MINUTE;
    const extra = count > ORDINARY_WEEK_MINUTES;
    buckets.total += 1;
    if (extra) buckets[night ? "extraNight" : "extraDay"] += 1;
    else buckets[night ? "ordinaryNight" : "ordinaryDay"] += 1;
    // Sunday and holiday are independent flags: a holiday Sunday counts in both on purpose.
    const sunday = day === 6;
    if (sunday) buckets.sunday += 1;
    if (isHoliday[day]) buckets.festive += 1;
    if (sunday && isHoliday[day]) buckets.sundayFestive += 1;
  }
  return buckets;
}

/** Weekly payroll concepts from the minute buckets. */
export function weekNovelties(buckets, weekStart) {
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    workedHours: roundHours(hours(buckets.total)),
    extras: roundHours(hours(buckets.extraDay + buckets.extraNight)),
    nocturnas: roundHours(hours(buckets.ordinaryNight) + hours(buckets.extraNight)),
    dominicales: roundHours(hours(buckets.sunday)),
    festivos: roundHours(hours(buckets.festive)),
    sundayFestiveHours: hours(buckets.sundayFestive),
    hasOverlap: buckets.hasOverlap,
  };
}

const TOTAL_KEYS = ["workedHours", "extras", "nocturnas", "dominicales", "festivos", "sundayFestiveHours"];

/** One employee over a cut of whole weeks [from, to] (from = Monday, to = Sunday). */
export function employeeNovelties(rows, from, to, holidays) {
  const weeks = [];
  for (let start = from; diffDays(to, start) >= 6; start = addDays(start, 7)) {
    weeks.push(weekNovelties(weekMinuteBuckets(rows, start, holidays), start));
  }
  const totals = {};
  for (const key of TOTAL_KEYS) {
    totals[key] = roundHours(weeks.reduce((acc, w) => acc + w[key], 0));
  }
  return { weeks, totals };
}
