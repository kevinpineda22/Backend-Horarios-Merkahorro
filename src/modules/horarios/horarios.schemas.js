import { z } from "zod";
import { isoDow, toEpochDay } from "../sugerido/domain/dates.js";
import { TIPOS } from "./domain/weekPayload.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CEDULA_RE = /^[0-9]{5,15}$/;

export const MAX_CEDULAS = 300;
export const MAX_SHIFTS = 2100;
export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 200;

function isMonday(value) {
  try {
    toEpochDay(value);
    return isoDow(value) === 1;
  } catch {
    return false;
  }
}

const cedula = z.string({ required_error: "La cédula es obligatoria" }).regex(CEDULA_RE, "Cédula inválida");
const date = z.string({ required_error: "La fecha es obligatoria" }).regex(DATE_RE, "Fecha inválida (YYYY-MM-DD)");
const optionalText = (max) => z.string().max(max, `No puede superar ${max} caracteres`).nullish();

export const weekParamsSchema = z.object({
  sedeId: z.string({ required_error: "La sede es obligatoria" }).trim().min(1, "Sede inválida"),
  weekStart: date.refine(isMonday, "weekStart debe ser un lunes válido (YYYY-MM-DD)"),
});

// Unknown keys (need, coverage, totals, audit columns) are stripped, never persisted.
// Time formats, the default break and cross-field rules are enforced by domain/weekPayload.js.
const shiftIn = z.object({
  cedula,
  fecha: date,
  tipo: z.enum(TIPOS, { errorMap: () => ({ message: "Tipo de turno inválido" }) }),
  startTime: z.string().nullish(),
  endTime: z.string().nullish(),
  breakMinutes: z.number({ invalid_type_error: "breakMinutes debe ser un número" }).nullish(),
  lunchStart: z.string().nullish(),
  cargo: optionalText(120),
  observacion: optionalText(500),
});

export const saveBodySchema = z.object({
  expectedVersion: z
    .number({ required_error: "expectedVersion es obligatorio", invalid_type_error: "expectedVersion debe ser un número" })
    .int("expectedVersion debe ser un entero")
    .min(0, "expectedVersion no puede ser negativo"),
  cedulas: z
    .array(cedula)
    .min(1, "Debes enviar al menos una cédula")
    .max(MAX_CEDULAS, `No puedes enviar más de ${MAX_CEDULAS} cédulas`)
    .refine((list) => new Set(list).size === list.length, "Hay cédulas repetidas"),
  shifts: z.array(shiftIn).max(MAX_SHIFTS, `No puedes enviar más de ${MAX_SHIFTS} turnos`),
});

export const publishBodySchema = z.object({
  expectedVersion: z
    .number({ required_error: "expectedVersion es obligatorio", invalid_type_error: "expectedVersion debe ser un número" })
    .int("expectedVersion debe ser un entero")
    .min(1, "Solo se puede publicar un horario ya guardado"),
});

export const historyQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, "limit inválido")
    .transform(Number)
    .refine((n) => n >= 1 && n <= HISTORY_MAX_LIMIT, `limit debe estar entre 1 y ${HISTORY_MAX_LIMIT}`)
    .optional()
    .transform((n) => n ?? HISTORY_DEFAULT_LIMIT),
});
