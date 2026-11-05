import { addDays, diffDays, isoDow, toEpochDay } from "../../sugerido/domain/dates.js";
import { getHoliday } from "../../sugerido/domain/calendar.js";
import { spanMinutes, timeToMinutes } from "./weekPayload.js";

/**
 * Minute-level payroll rules over a week of shifts (pure). Twin of the frontend rules; the shared
 * fixture test/horarios/fixtures/weekParity.json keeps both in agreement.
 *
 * Rows are camelCase: { cedula, sedeId, fecha, tipo, startTime, endTime, breakMinutes, lunchStart }.
 * Times are minutes from Monday 00:00 of `weekStart` (Bogota wall clock); a shift whose end is at or
 * before its start crosses midnight.
 */

export const WEEKLY_LIMIT_MINUTES = 3360; // 56 h: > blocks publication
export const WARNING_MINUTES = 3240; // 54 h: > warns
const DAY = 1440;
const WEEK = 7 * DAY;
const REST_TIPOS = new Set(["DESCANSO", "COMPENSATORIO"]);
const NIGHT_START = 19 * 60;
const NIGHT_END = 6 * 60;

const absStart = (row, weekStart) => diffDays(row.fecha, weekStart) * DAY + timeToMinutes(row.startTime);

/** True when two shifts (same employee) overlap. Touching endpoints do not overlap. */
export function intervalsOverlap(a, b) {
  const base = toEpochDay(a.fecha);
  const range = (r) => {
    const start = (toEpochDay(r.fecha) - base) * DAY + timeToMinutes(r.startTime);
    return [start, start + spanMinutes(r.startTime, r.endTime)];
  };
  const [a0, a1] = range(a);
  const [b0, b1] = range(b);
  return a0 < b1 && a1 > b0;
}

/** Centered break, in minutes from midnight of the shift's start day. */
export function centeredBreak({ startTime, endTime, breakMinutes = 0 }) {
  const span = spanMinutes(startTime, endTime);
  const breakStart = timeToMinutes(startTime) + Math.floor((span - breakMinutes) / 2);
  return { breakStart, breakEnd: breakStart + breakMinutes };
}

/** Worked intervals of a TRABAJO row (break removed), clipped to the week window. */
function workedIntervals(row, weekStart) {
  const start = absStart(row, weekStart);
  const span = spanMinutes(row.startTime, row.endTime);
  const brk = row.breakMinutes ?? 0;
  const offset = Math.floor((span - brk) / 2);
  const pieces = brk > 0 ? [[start, start + offset], [start + offset + brk, start + span]] : [[start, start + span]];
  return pieces
    .map(([s, e]) => [Math.max(s, 0), Math.min(e, WEEK)])
    .filter(([s, e]) => e > s);
}

function mergedMinutes(intervals) {
  const sorted = [...intervals].sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = null;
  let curEnd = null;
  for (const [s, e] of sorted) {
    if (curEnd === null || s > curEnd) {
      if (curEnd !== null) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd !== null) total += curEnd - curStart;
  return total;
}

/** { cedula: minutes } for every cedula with a TRABAJO row; merged per cedula across sedes. */
export function workedMinutesByCedula(rows, weekStart) {
  const byCedula = new Map();
  for (const row of rows) {
    if (row.tipo !== "TRABAJO") continue;
    if (!byCedula.has(row.cedula)) byCedula.set(row.cedula, []);
    byCedula.get(row.cedula).push(...workedIntervals(row, weekStart));
  }
  const out = {};
  for (const [cedula, intervals] of byCedula) out[cedula] = mergedMinutes(intervals);
  return out;
}

const inWeek = (fecha, weekStart) => {
  const d = diffDays(fecha, weekStart);
  return d >= 0 && d <= 6;
};

const sortedScope = (scope) => [...new Set(scope)].sort();

/**
 * Publication blockers. `scopeCedulas` = employees with a TRABAJO row in THIS sede-week; `rows`
 * hold every sede's rows for them (hours and rest both count across sedes).
 * Order: by cedula, hours blocker before rest blocker.
 */
export function publishBlockers(rows, weekStart, scopeCedulas) {
  const worked = workedMinutesByCedula(rows, weekStart);
  const withRest = new Set(
    rows.filter((r) => REST_TIPOS.has(r.tipo) && inWeek(r.fecha, weekStart)).map((r) => r.cedula),
  );
  const blockers = [];
  for (const cedula of sortedScope(scopeCedulas)) {
    const minutes = worked[cedula] ?? 0;
    if (minutes > WEEKLY_LIMIT_MINUTES) {
      blockers.push({ cedula, code: "LIMITE_HORAS_EXTRA_SEMANAL", workedMinutes: minutes, limitMinutes: WEEKLY_LIMIT_MINUTES });
    }
    if (!withRest.has(cedula)) blockers.push({ cedula, code: "DESCANSO_SEMANAL_OBLIGATORIO" });
  }
  return blockers;
}

/** Night (19:00-06:00) and Sunday/holiday minutes inside [from, to), minutes from `fecha` midnight. */
function franjaMinutes(fecha, from, to) {
  let night = 0;
  let special = 0;
  for (let m = from; m < to; m += 1) {
    const mod = ((m % DAY) + DAY) % DAY;
    if (mod >= NIGHT_START || mod < NIGHT_END) night += 1;
    const date = addDays(fecha, Math.floor(m / DAY));
    if (isoDow(date) === 7 || getHoliday(date)) special += 1;
  }
  return { night, special };
}

function breakBoundaryMismatch(row) {
  if (row.tipo !== "TRABAJO" || !row.lunchStart || !(row.breakMinutes > 0)) return false;
  const centered = centeredBreak(row);
  let lunch = timeToMinutes(row.lunchStart);
  if (lunch < timeToMinutes(row.startTime)) lunch += DAY; // lunch after midnight of a crossing shift
  const a = franjaMinutes(row.fecha, centered.breakStart, centered.breakEnd);
  const b = franjaMinutes(row.fecha, lunch, lunch + row.breakMinutes);
  return a.night !== b.night || a.special !== b.special;
}

/** Non-blocking warnings: > 54 h worked, and a planned lunch that payroll would price differently. */
export function weekWarnings(rows, weekStart, scopeCedulas) {
  const worked = workedMinutesByCedula(rows, weekStart);
  const scope = sortedScope(scopeCedulas);
  const warnings = [];
  for (const cedula of scope) {
    if ((worked[cedula] ?? 0) > WARNING_MINUTES) {
      warnings.push({ code: "HORAS_EXTRA_SOBRE_12", cedula, workedMinutes: worked[cedula] });
    }
  }
  const inScope = new Set(scope);
  const mismatched = rows
    .filter((r) => inScope.has(r.cedula) && inWeek(r.fecha, weekStart) && breakBoundaryMismatch(r))
    .sort((x, y) => (x.cedula + x.fecha < y.cedula + y.fecha ? -1 : 1));
  for (const r of mismatched) warnings.push({ code: "BREAK_BOUNDARY_MISMATCH", cedula: r.cedula, fecha: r.fecha });
  return warnings;
}
