// Port of normalizeBlockingObservation / inferBlockingEnd from the legacy scheduler
// (Programador_horarios/utils/programadorHorariosUtils.js). Dates are 'YYYY-MM-DD'
// strings; no Date objects, so there is no local-midnight drift.
import { addDays, toEpochDay, weekDates } from "./dates.js";

export const ABSENCE_TYPES = Object.freeze([
  "Incapacidades",
  "Licencias",
  "Vacaciones",
  "Permisos",
  "Estudio",
  "Día de la Familia",
]);

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

export function inferBlockingEnd(tipo, start, rawEnd, details = {}) {
  const invalid = (end) => !end || end < start;
  let end = parseDateOnly(rawEnd);

  if (invalid(end) && tipo === "Vacaciones") {
    const regreso = parseDateOnly(details.fecha_regreso_vacaciones);
    if (regreso) end = addDays(regreso, -1);
  }
  if (invalid(end)) {
    const duration = Number(details.duracion_dias);
    if (!Number.isNaN(duration) && duration > 0) end = addDays(start, duration - 1);
  }
  if (invalid(end)) {
    let days = NaN;
    if (typeof details.diasIncapacidad === "number") days = details.diasIncapacidad;
    else if (typeof details.diasIncapacidad === "string") {
      const match = details.diasIncapacidad.match(/\d+/);
      if (match) days = Number(match[0]);
    }
    if (!Number.isNaN(days) && days > 0) end = addDays(start, days - 1);
  }
  return invalid(end) ? start : end;
}

function candidates(tipo, obs, details) {
  switch (tipo) {
    case "Vacaciones": {
      const regreso = parseDateOnly(details.fecha_regreso_vacaciones);
      return [
        details.fecha_inicio_vacaciones || obs.fecha_novedad,
        details.fecha_fin_vacaciones || (regreso ? addDays(regreso, -1) : undefined),
      ];
    }
    // Intentional divergence from legacy Programador_horarios: legacy defaulted the end to
    // fecha_inicio (1 day) when the end field was missing. Here a missing end falls through to
    // inferBlockingEnd, which applies duracion_dias / diasIncapacidad before defaulting to start.
    case "Licencias":
      return [details.fecha_inicio || obs.fecha_novedad, details.fecha_termino];
    case "Incapacidades":
      return [details.fecha_inicio || obs.fecha_novedad, details.fecha_fin];
    case "Permisos":
    case "Día de la Familia": {
      const proposed = tipo === "Día de la Familia" ? details.fecha_propuesta_dia_familia : undefined;
      return [
        details.fecha_inicio || proposed || obs.fecha_novedad,
        details.fecha_fin || details.fecha_inicio || proposed || obs.fecha_novedad,
      ];
    }
    case "Estudio": {
      const days = Array.isArray(details.dias_estudio) ? details.dias_estudio : [];
      if (days.length > 0) {
        const sorted = days.map((d) => d.fecha).sort();
        return [sorted[0], sorted[sorted.length - 1]];
      }
      return [details.fecha_inicio || obs.fecha_novedad, details.fecha_fin || details.fecha_inicio || obs.fecha_novedad];
    }
    default:
      return [obs.fecha_novedad, obs.fecha_novedad];
  }
}

/** Returns { id, cedula, tipo, start, end } or null when the row is not a blocking absence. */
export function normalizeBlockingObservation(obs, blockingTypes = ABSENCE_TYPES) {
  if (!obs) return null;
  const tipo = obs.tipo_novedad || obs.tipo;
  if (!tipo || !ABSENCE_TYPES.includes(tipo) || !blockingTypes.includes(tipo)) return null;

  const details = obs.details && typeof obs.details === "object" ? obs.details : {};
  const [startCandidate, endCandidate] = candidates(tipo, obs, details);
  const start = parseDateOnly(startCandidate);
  if (!start) return null;

  const cedula = obs.cedula == null ? "" : String(obs.cedula).trim();
  return { id: obs.id, cedula, tipo, start, end: inferBlockingEnd(tipo, start, endCandidate, details) };
}

/** Normalizes a raw list; blocking rows that cannot be used become warnings. */
export function normalizeAbsences(list, blockingTypes = ABSENCE_TYPES) {
  const absences = [];
  const warnings = [];
  for (const obs of Array.isArray(list) ? list : []) {
    const tipo = obs?.tipo_novedad || obs?.tipo;
    if (!ABSENCE_TYPES.includes(tipo) || !blockingTypes.includes(tipo)) continue;
    const a = normalizeBlockingObservation(obs, blockingTypes);
    if (!a) warnings.push(`Absence ${obs.id} (${tipo}) skipped: unparseable start date`);
    else if (!a.cedula) warnings.push(`Absence ${obs.id} (${tipo}) skipped: missing cedula`);
    else absences.push(a);
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
