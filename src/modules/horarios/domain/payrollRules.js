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

/** The 20 SIESA novelty columns, verbatim from the old export (checked by the parity fixture). */
export const SIESA_HEADERS = Object.freeze([
  "CODIGO DEL EMPLEADO (Obligatorio)",
  "SUCURSAL (Obligatorio)",
  "CODIGO DEL CONCEPTO (Obligatorio)",
  "CENTRO DE OPERACION (No obligatorio, Vacío asume el centro de operación del contrato)",
  "CENTRO DE COSTO (No obligatorio, Vacío asume el centro de costo del contrato)",
  "FECHA MOVIMIENTO (YYYYMMDD, No obligatorio)",
  "HORAS (Puede recibir dos decimales con separador punto (.), Obligatorio)",
  "VALOR (Puede recibir dos decimales con separador punto (.), Obligatorio)",
  "CANTIDAD (No obligatorio)",
  "PROYECTO (No obligatorio, Vacío asume el proyecto del contrato)",
  "NUMERO DE CONTRATO DEL EMPLEADO (No obligatorio, si el empleado tiene 1 contrato activo, se toma este, de lo contrario genera error)",
  "UNIDAD DE NEGOCIO (No obligatorio, Vacío asume la unidad de negocio del contrato)",
  "FECHA DE CAUSACION (YYYYMMDD, No obligatorio)",
  "NUMERO DE CUOTA (No obligatorio)",
  "FECHA INICIAL (Obligatorio si el concepto es liquidacion por agrupacion, YYYYMMDD)",
  "FECHA FINAL (Obligatorio si el concepto es liquidacion por agrupacion, YYYYMMDD)",
  "ID AGRUPACION (Obligatorio si el concepto es liquidacion por agrupacion)",
  "IND LIQUIDACION (Obligatorio si el concepto es liquidacion por agrupacion, 0 = Sueldo, 1 = Sueldo+Promedio, 2 = Promedio de agrupacion)",
  "DIAS (No Obligatorio)",
  "NOTAS (No obligatorio)",
]);

// Export order of the concepts: 103 Sunday, 105 holiday, 108 extras, 113 night surcharge.
const SIESA_CONCEPTS = [
  { code: 103, key: "dominicales" },
  { code: 105, key: "festivos" },
  { code: 108, key: "extras" },
  { code: 113, key: "nocturnas" },
];

const siesaIdentifier = (value) => {
  const text = String(value ?? "").trim();
  return /^\d{1,15}$/.test(text) ? Number(text) : text;
};

/**
 * SIESA rows (20 cells each) for lines [{ cedula, siesaCode, weeks: [weekNovelties] }].
 * Concepts with <= 0 hours are skipped; the same cedula + branch + concept is summed.
 * The contract number column stays empty (SIESA picks the single active contract).
 */
export function siesaTuples(lines) {
  const grouped = new Map();
  for (const line of lines) {
    const cedula = String(line.cedula ?? "").trim();
    const branch = String(line.siesaCode ?? "").trim().padStart(3, "0");
    for (const concept of SIESA_CONCEPTS) {
      const total = roundHours((line.weeks || []).reduce((acc, w) => acc + Number(w[concept.key] || 0), 0));
      if (total <= 0) continue;
      const key = [cedula, branch, "", concept.code].join("|");
      const current = grouped.get(key);
      if (current) current.hours = roundHours(current.hours + total);
      else grouped.set(key, { cedula, branch, code: concept.code, hours: total });
    }
  }
  return [...grouped.values()].map((g) => [
    siesaIdentifier(g.cedula), g.branch, g.code, "", "", "", g.hours, 0, "", "", "",
    "", "", "", "", "", "", "", "", "",
  ]);
}

/** Compares a cut total with the previous one (hours). Mirrors the old analyticsVariation. */
export function variation(current, previous) {
  const cur = roundHours(current);
  if (previous === null || previous === undefined) {
    return { current: cur, previous: null, delta: null, percent: null, kind: "none", review: false };
  }
  const prev = roundHours(previous);
  const delta = roundHours(cur - prev);
  if (prev === 0) {
    return {
      current: cur,
      previous: prev,
      delta,
      percent: cur === 0 ? 0 : null,
      kind: cur > 0 ? "new" : "flat",
      review: cur >= 4,
    };
  }
  const percent = Math.round(((cur - prev) / prev) * 1000) / 10;
  return {
    current: cur,
    previous: prev,
    delta,
    percent,
    kind: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
    review: Math.abs(delta) >= 4 && Math.abs(percent) >= 25,
  };
}
