import { absentDaysByCedula } from "./absences.js";
import { weekDates } from "./dates.js";

const DAYS_PER_WEEK = 7;
const SETTING_KEYS = ["ordinaryWeeklyHours", "overtimeWeeklyHours", "dailyMaxHours", "maxWorkingDaysPerWeek"];

function validate(settings) {
  for (const key of SETTING_KEYS) {
    if (typeof settings[key] !== "number" || !Number.isFinite(settings[key])) {
      throw new Error(`${key} must be a finite number`);
    }
  }
  if (settings.maxWorkingDaysPerWeek < 1) throw new Error("maxWorkingDaysPerWeek must be at least 1");
}

/**
 * Cashier availability for one sede-week. Slots are never trimmed here; shortfalls are flagged.
 * pool: [{ cedula }] active cashiers; absences: normalized blocking absences (see absences.js).
 * requiredHoursByDay: { [fecha]: cashier-hours needed } from the headcount step.
 * Per cashier: workdays = min(maxWorkingDaysPerWeek, 7 - absentDays), so one absent day is
 * absorbed by the weekly rest day. Weekly hours are pro-rated on workdays / maxWorkingDaysPerWeek.
 */
export function computeAvailability({ weekStart, pool, absences, settings, requiredHoursByDay = {} }) {
  validate(settings);
  const { ordinaryWeeklyHours, overtimeWeeklyHours, dailyMaxHours, maxWorkingDaysPerWeek } = settings;

  const cedulas = [...new Set(pool.map((p) => String(p.cedula).trim()).filter(Boolean))];
  const absent = absentDaysByCedula(absences, weekStart);
  const days = weekDates(weekStart);

  const available = Object.fromEntries(days.map((d) => [d, 0]));
  let workdays = 0;
  for (const c of cedulas) {
    const off = absent.get(c) ?? new Set();
    for (const d of days) if (!off.has(d)) available[d] += 1;
    workdays += Math.min(maxWorkingDaysPerWeek, DAYS_PER_WEEK - off.size);
  }

  const share = workdays / maxWorkingDaysPerWeek;
  const ordinaryCapH = ordinaryWeeklyHours * share;
  const maxCapH = (ordinaryWeeklyHours + overtimeWeeklyHours) * share;
  const requiredH = days.reduce((s, d) => s + (requiredHoursByDay[d] ?? 0), 0);

  return {
    available,
    requiredH,
    ordinaryCapH,
    maxCapH,
    overtimeNeeded: requiredH > ordinaryCapH,
    weeklyShortfall: requiredH > maxCapH,
    dailyShortfall: Object.fromEntries(days.map((d) => [d, (requiredHoursByDay[d] ?? 0) > available[d] * dailyMaxHours])),
  };
}
