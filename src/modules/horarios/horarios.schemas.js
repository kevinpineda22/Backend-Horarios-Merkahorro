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
// Postgres text cannot hold NUL (22P05), so it would surface as a 500: reject it up front.
const optionalText = (max) =>
  z
    .string()
    .max(max, `No puede superar ${max} caracteres`)
    .refine((v) => !v.includes("\u0000"), "Caracteres no permitidos")
    .nullish();

const sedeId = z.string({ required_error: "La sede es obligatoria" }).trim().min(1, "Sede inválida");

export const SCHEDULE_STATES = ["PUBLICADO", "BORRADOR"]; // sede_week_schedules.state (004_shifts.sql)
export const SCHEDULES_DEFAULT_LIMIT = 26;
export const SCHEDULES_MAX_LIMIT = 52;

export const sedeParamsSchema = z.object({ sedeId });

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
  // null/absent means "the week was never saved" (version 0).
  expectedVersion: z
    .number({ invalid_type_error: "expectedVersion debe ser un número" })
    .int("expectedVersion debe ser un entero")
    .min(0, "expectedVersion no puede ser negativo")
    .nullish()
    .transform((v) => v ?? 0),
  cedulas: z
    .array(cedula)
    .min(1, "Debes enviar al menos una cédula")
    .max(MAX_CEDULAS, `No puedes enviar más de ${MAX_CEDULAS} cédulas`)
    .refine((list) => new Set(list).size === list.length, "Hay cédulas repetidas"),
  shifts: z.array(shiftIn).max(MAX_SHIFTS, `No puedes enviar más de ${MAX_SHIFTS} turnos`),
});

// What the leader saw when publishing (migration 013): the recommendation (cashiers needed per 15-minute slot, after
// adjustments) and the schedule the system suggested. Stored as sent, only to compare it later with what was published.
const MAX_SNAPSHOT_SLOTS = 7 * 96;
const recommendationSnapshot = z.object({
  runVersion: z.number().int().min(0).nullish(),
  dataAsOf: z.string().regex(DATE_RE, "Fecha inválida (YYYY-MM-DD)").nullish(),
  registers: z.number().int().min(0).max(500).nullish(),
  slots: z
    .array(
      z.object({
        fecha: date,
        franja: z.string().regex(/^\d{2}:\d{2}$/, "Franja inválida (HH:MM)"),
        final: z.number().int().min(0).max(500),
      }),
    )
    .max(MAX_SNAPSHOT_SLOTS),
});
const suggestedSnapshot = z.object({ shifts: z.array(shiftIn).max(MAX_SHIFTS, `No puedes enviar más de ${MAX_SHIFTS} turnos`) });

export const publishBodySchema = z.object({
  expectedVersion: z
    .number({ required_error: "expectedVersion es obligatorio", invalid_type_error: "expectedVersion debe ser un número" })
    .int("expectedVersion debe ser un entero")
    .min(1, "Solo se puede publicar un horario ya guardado"),
  // Lenient on purpose: a malformed snapshot is dropped (null) instead of rejecting the publication.
  snapshot: z.object({ recommendation: recommendationSnapshot.nullish(), suggested: suggestedSnapshot.nullish() }).nullish().catch(null),
});

export const unpublishBodySchema = z.object({
  expectedVersion: z
    .number({ required_error: "expectedVersion es obligatorio", invalid_type_error: "expectedVersion debe ser un número" })
    .int("expectedVersion debe ser un entero")
    .min(1, "Solo se puede despublicar un horario ya publicado"),
});

export const snapshotParamsSchema = z.object({
  sedeId,
  snapshotId: z.string().uuid("Id inválido"),
});

export const SNAPSHOTS_DEFAULT_LIMIT = 26;
export const snapshotsListQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, "limit inválido")
    .transform(Number)
    .refine((n) => n >= 1 && n <= 52, "limit debe estar entre 1 y 52")
    .optional()
    .transform((n) => n ?? SNAPSHOTS_DEFAULT_LIMIT),
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

// GET /sedes/:sedeId/schedules?status=PUBLICADO&limit=26
export const schedulesListQuerySchema = z.object({
  status: z.enum(SCHEDULE_STATES, { errorMap: () => ({ message: "status debe ser PUBLICADO o BORRADOR" }) }).default("PUBLICADO"),
  limit: z
    .string()
    .regex(/^\d+$/, "limit inválido")
    .transform(Number)
    .refine((n) => n >= 1 && n <= SCHEDULES_MAX_LIMIT, `limit debe estar entre 1 y ${SCHEDULES_MAX_LIMIT}`)
    .optional()
    .transform((n) => n ?? SCHEDULES_DEFAULT_LIMIT),
});
