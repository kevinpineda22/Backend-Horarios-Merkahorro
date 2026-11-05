import { createHttpError } from "../../../shared/http/HttpError.js";
import { diffDays, toEpochDay } from "../../sugerido/domain/dates.js";

/**
 * Structural validation of a week save payload (pure). It guarantees that nothing reaches the
 * database that its CHECK constraints would reject, so a bad payload is always a 400
 * INVALID_SHIFTS and never a raw 23514 / 500.
 *
 * Input rows are camelCase: { cedula, fecha, tipo, startTime, endTime, breakMinutes?, lunchStart,
 * cargo, observacion }. Output rows are normalized (default break applied, rest rows without times).
 */

export const TIPOS = Object.freeze(["TRABAJO", "DESCANSO", "COMPENSATORIO"]);
export const DEFAULT_BREAK_MINUTES = 60;
export const MAX_BREAK_MINUTES = 480;
const DAY_MINUTES = 1440;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CEDULA_RE = /^[0-9]{5,15}$/;

/** "HH:MM" -> minutes since midnight. "24:00" is accepted only with `allow24` (end of shift). */
export function timeToMinutes(value, { allow24 = false } = {}) {
  if (allow24 && value === "24:00") return DAY_MINUTES;
  const m = TIME_RE.exec(String(value));
  if (!m) throw new Error(`Invalid time: ${value}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Length in minutes of a shift; an end at or before the start falls on the next day. */
export function spanMinutes(startTime, endTime) {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime, { allow24: true });
  return end <= start ? end - start + DAY_MINUTES : end - start;
}

const isBlank = (v) => v === undefined || v === null;

function invalid(details) {
  const err = createHttpError(400, "Los turnos enviados no son válidos.", "INVALID_SHIFTS");
  err.details = details;
  return err;
}

function validDate(fecha) {
  try {
    toEpochDay(fecha);
    return true;
  } catch {
    return false;
  }
}

function normalizeRow(row, i, { weekStart, cedulaSet }) {
  const at = (field) => `shifts.${i}.${field}`;
  const problems = [];
  const bad = (field, message) => problems.push({ path: at(field), message });

  if (!CEDULA_RE.test(String(row?.cedula ?? ""))) bad("cedula", "Cédula inválida");
  else if (!cedulaSet.has(row.cedula)) bad("cedula", "La cédula no está en la lista de cédulas enviadas");

  if (!validDate(row?.fecha)) bad("fecha", "Fecha inválida");
  else {
    const offset = diffDays(row.fecha, weekStart);
    if (offset < 0 || offset > 6) bad("fecha", "La fecha está fuera de la semana");
  }

  if (!TIPOS.includes(row?.tipo)) bad("tipo", "Tipo de turno inválido");

  const out = {
    cedula: row?.cedula,
    fecha: row?.fecha,
    tipo: row?.tipo,
    startTime: null,
    endTime: null,
    breakMinutes: 0,
    lunchStart: null,
    cargo: isBlank(row?.cargo) ? null : row.cargo,
    observacion: isBlank(row?.observacion) ? null : row.observacion,
  };

  if (row?.tipo === "TRABAJO") {
    const beforeTimes = problems.length;
    if (isBlank(row.startTime) || !TIME_RE.test(String(row.startTime))) bad("startTime", "Hora de inicio inválida (HH:MM)");
    if (isBlank(row.endTime) || !(TIME_RE.test(String(row.endTime)) || row.endTime === "24:00")) {
      bad("endTime", "Hora de fin inválida (HH:MM)");
    }
    const timesOk = problems.length === beforeTimes;
    if (!isBlank(row.lunchStart) && !TIME_RE.test(String(row.lunchStart))) bad("lunchStart", "Hora de almuerzo inválida (HH:MM)");

    // Default first, then validate: a defaulted break must still fit the span.
    const breakMinutes = isBlank(row.breakMinutes) ? DEFAULT_BREAK_MINUTES : row.breakMinutes;
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > MAX_BREAK_MINUTES) {
      bad("breakMinutes", `El descanso debe estar entre 0 y ${MAX_BREAK_MINUTES} minutos`);
    }

    if (timesOk) {
      if (row.startTime === row.endTime) bad("endTime", "El turno no puede empezar y terminar a la misma hora");
      else if (Number.isInteger(breakMinutes) && breakMinutes >= spanMinutes(row.startTime, row.endTime)) {
        bad("breakMinutes", "El descanso debe ser menor que la duración del turno");
      }
    }

    out.startTime = row.startTime;
    out.endTime = row.endTime;
    out.breakMinutes = breakMinutes;
    out.lunchStart = isBlank(row.lunchStart) ? null : row.lunchStart;
  } else if (TIPOS.includes(row?.tipo)) {
    if (!isBlank(row.startTime)) bad("startTime", "Un día de descanso no lleva hora de inicio");
    if (!isBlank(row.endTime)) bad("endTime", "Un día de descanso no lleva hora de fin");
    if (!isBlank(row.lunchStart)) bad("lunchStart", "Un día de descanso no lleva hora de almuerzo");
    if (!isBlank(row.breakMinutes) && row.breakMinutes !== 0) bad("breakMinutes", "Un día de descanso no lleva tiempo de descanso");
  }

  return { out, problems };
}

/**
 * Validates and normalizes the shifts of one sede-week save. Throws a 400 INVALID_SHIFTS listing
 * every problem. `cedulas` are the employees the caller owns; `weekStart` is the Monday.
 */
export function normalizeWeekPayload({ weekStart, cedulas, shifts }) {
  if (!Array.isArray(shifts)) throw invalid([{ path: "shifts", message: "shifts debe ser una lista" }]);
  const ctx = { weekStart, cedulaSet: new Set(cedulas) };
  const seen = new Set();
  const details = [];
  const rows = [];

  shifts.forEach((row, i) => {
    const { out, problems } = normalizeRow(row, i, ctx);
    details.push(...problems);
    const key = `${out.cedula}|${out.fecha}`;
    if (seen.has(key)) details.push({ path: `shifts.${i}`, message: "Hay más de un turno para la misma cédula y fecha" });
    seen.add(key);
    rows.push(out);
  });

  if (details.length) throw invalid(details);
  return rows;
}
