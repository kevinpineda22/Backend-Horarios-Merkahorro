import { z } from "zod";
import { isoDow, toEpochDay, weekDates } from "./domain/dates.js";
import { NOVEDAD_TYPES } from "../novedades/domain/novedadTypes.js";

export const MAX_OVERRIDE_ITEMS = 700;
const MAX_HEADCOUNT = 2_147_483_647; // Postgres int4: the column behind sugerido_overrides.headcount

const isRealDate = (v) => {
  try {
    toEpochDay(v);
    return true;
  } catch {
    return false;
  }
};

const dateOnly = z
  .string({ required_error: "La fecha es obligatoria" })
  .refine(isRealDate, { message: "Fecha inválida (use AAAA-MM-DD)" });

const sedeId = z.string({ required_error: "La sede es obligatoria" }).trim().min(1, "Sede inválida");

const weekStart = dateOnly.refine((v) => !isRealDate(v) || isoDow(v) === 1, {
  message: "La semana debe iniciar un lunes",
});

export const sedeParamsSchema = z.object({ sedeId });
export const weekParamsSchema = z.object({ sedeId, weekStart });

// 15-minute boundary, 'HH:MM' only (the database column is time).
const franja = z.string().regex(/^([01]\d|2[0-3]):(00|15|30|45)$/, "Franja inválida (use HH:MM en intervalos de 15 minutos)");

// value null removes the override; an omitted value is an error, never an implicit removal.
const value = z.union([z.number().int().min(0).max(MAX_HEADCOUNT), z.null()], {
  errorMap: () => ({ message: "El valor debe ser un entero no negativo o null" }),
});

/**
 * PUT overrides body for one week: an array of { fecha, franja, value }.
 * The week comes from the URL, so this is a factory. A weekStart that is not a real date
 * only skips the in-week check: the params schema reports that error on its own.
 */
export function createOverridesBodySchema(weekStartParam) {
  const days = isRealDate(weekStartParam) && isoDow(weekStartParam) === 1 ? new Set(weekDates(weekStartParam)) : null;
  const fecha = days
    ? dateOnly.refine((v) => days.has(v), { message: "La fecha debe estar dentro de la semana indicada" })
    : dateOnly;

  return z
    .array(z.object({ fecha, franja, value }), { invalid_type_error: "Se esperaba una lista de overrides" })
    .min(1, "Debes enviar al menos un override")
    .max(MAX_OVERRIDE_ITEMS, `No puedes enviar más de ${MAX_OVERRIDE_ITEMS} overrides`)
    .superRefine((items, ctx) => {
      const seen = new Set();
      items.forEach((item, index) => {
        const key = `${item.fecha}|${item.franja}`;
        if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Override duplicado para la misma fecha y franja", path: [index] });
        seen.add(key);
      });
    });
}

// ---------------------------------------------------------------------------
// Settings (PUT /settings). Ranges: utilization in (0, 1], hours > 0, working days 1..7 and
// blockingAbsenceTypes a subset of the novedad tipos (spec R6.3). The upper bounds on hours and
// counts are physical/sanity limits (a day has 24 h, a week 168 h), not business rules.
// ---------------------------------------------------------------------------
const MAX_WEEK_HOURS = 168;
const MAX_DAY_HOURS = 24;
const MAX_MIN_CASHIERS = 100;
const MAX_STALE_DAYS = 365;
const MIN_UTILIZATION = 0.1;

const hours = (max) =>
  z.number({ invalid_type_error: "Debe ser un número" }).finite().gt(0, "Debe ser mayor que 0").max(max, `No puede superar ${max}`);
const wholeNumber = (min, max) =>
  z.number({ invalid_type_error: "Debe ser un número entero" }).int("Debe ser un número entero").min(min, `Debe ser al menos ${min}`).max(max, `No puede superar ${max}`);

/**
 * Partial settings update: at least one recognised key, unknown keys are stripped (so id,
 * updatedBy or updatedAt can never be set from the body). Strict numbers: no string coercion.
 */
export const settingsPatchSchema = z
  .object({
    ordinaryWeeklyHours: hours(MAX_WEEK_HOURS),
    overtimeWeeklyHours: hours(MAX_WEEK_HOURS),
    dailyMaxHours: hours(MAX_DAY_HOURS),
    // Lower bound 0.1, not just > 0: headcount divides by productivity × utilization, so a
    // typo near zero would blow every sede's suggestion up to Infinity.
    utilization: z
      .number({ invalid_type_error: "Debe ser un número" })
      .min(MIN_UTILIZATION, `Debe ser al menos ${MIN_UTILIZATION}`)
      .max(1, "No puede superar 1"),
    maxWorkingDaysPerWeek: wholeNumber(1, 7),
    minCashiers: wholeNumber(0, MAX_MIN_CASHIERS),
    staleAfterDays: wholeNumber(0, MAX_STALE_DAYS),
    blockingAbsenceTypes: z
      .array(z.enum(NOVEDAD_TYPES, { errorMap: () => ({ message: "Tipo de ausencia inválido" }) }), {
        invalid_type_error: "Se esperaba una lista de tipos de ausencia",
      })
      .transform((types) => [...new Set(types)]),
  })
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), { message: "Debes enviar al menos un parámetro" });
