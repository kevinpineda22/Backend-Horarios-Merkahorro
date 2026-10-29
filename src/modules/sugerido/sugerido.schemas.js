import { z } from "zod";
import { isoDow, toEpochDay, weekDates } from "./domain/dates.js";

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
