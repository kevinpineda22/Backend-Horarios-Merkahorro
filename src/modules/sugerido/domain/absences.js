// Absences are plain inclusive date ranges over `novedades` rows
// ({ id, cedula, tipo, fecha_inicio, fecha_fin, anulada }). Dates are 'YYYY-MM-DD'
// strings; no Date objects, so there is no local-midnight drift.
import { toEpochDay, weekDates } from "./dates.js";

// Novedades owns the canonical list; sugerido consumes it under its own name.
export { NOVEDAD_TYPES as ABSENCE_TYPES } from "../../novedades/domain/novedadTypes.js";
import { NOVEDAD_TYPES as ABSENCE_TYPES } from "../../novedades/domain/novedadTypes.js";

/** First 10 chars as 'YYYY-MM-DD' when it is a real calendar date, otherwise null. */
export function parseDateOnly(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().slice(0, 10);
  try {
    toEpochDay(raw);
    return raw;
  } catch {
    return null;
  }
}

/** Trim and strip non-digit separators (spaces, dots); same rule as the novedades API. */
function normalizeCedula(value) {
  return value == null ? "" : String(value).replace(/\D/g, "");
}

/**
 * Normalizes novedades rows into { id, cedula, tipo, start, end } ranges.
 * Cancelled rows and types outside `blockingTypes` are skipped silently; rows that
 * cannot be used become warnings.
 */
export function normalizeAbsences(rows, blockingTypes = ABSENCE_TYPES) {
  const absences = [];
  const warnings = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.anulada === true) continue;
    const { id, tipo } = row;
    if (!ABSENCE_TYPES.includes(tipo) || !blockingTypes.includes(tipo)) continue;

    const cedula = normalizeCedula(row.cedula);
    const start = parseDateOnly(row.fecha_inicio);
    const end = parseDateOnly(row.fecha_fin);
    if (!cedula) warnings.push(`Absence ${id} (${tipo}) skipped: missing cedula`);
    else if (!start || !end) warnings.push(`Absence ${id} (${tipo}) skipped: invalid date`);
    else if (end < start) warnings.push(`Absence ${id} (${tipo}) skipped: end before start`);
    else absences.push({ id, cedula, tipo, start, end });
  }
  return { absences, warnings };
}

/** Map cedula -> Set of dates of the target week on which the cashier is absent. */
export function absentDaysByCedula(absences, weekStart) {
  const days = weekDates(weekStart);
  const map = new Map();
  for (const a of absences) {
    for (const d of days) {
      if (d < a.start || d > a.end) continue;
      if (!map.has(a.cedula)) map.set(a.cedula, new Set());
      map.get(a.cedula).add(d);
    }
  }
  return map;
}
