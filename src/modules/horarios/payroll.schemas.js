import { z } from "zod";

const text = z.string().trim();

// Only the shape is checked here: whether [from, to] is a valid payroll cut (Monday start,
// 7 or 14 days) is decided by the service, which answers 400 PAYROLL_PERIOD_INVALID.
// Both dates or neither: the service then falls back to the default period.
export const reportQuerySchema = z.object({
  from: text.optional(),
  to: text.optional(),
  sedeId: text.min(1, "Sede inválida").optional(),
});

const CUTS_MAX_LIMIT = 200;

export const cutsQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, "limit inválido")
    .transform(Number)
    .refine((n) => n >= 1 && n <= CUTS_MAX_LIMIT, `limit debe estar entre 1 y ${CUTS_MAX_LIMIT}`)
    .optional(),
});

export const cutParamsSchema = z.object({
  id: z
    .string()
    .regex(/^[1-9][0-9]{0,14}$/, "Corte inválido")
    .transform(Number),
});

// Narrows a saved cut to one sede (same meaning as in the report).
export const cutQuerySchema = z.object({
  sedeId: text.min(1, "Sede inválida").optional(),
});

// Numbers are never accepted from the client (A5): the server recomputes. The fingerprint is the
// proof of which report the admin reviewed; unknown keys are stripped.
export const saveCutBodySchema = z.object({
  from: text.min(1, "from es obligatorio"),
  to: text.min(1, "to es obligatorio"),
  fingerprint: text.min(1, "fingerprint es obligatorio"),
});

// The reason is optional; a missing body counts as an empty one.
export const voidCutBodySchema = z.preprocess(
  (value) => value ?? {},
  z.object({ reason: text.max(500, "El motivo admite máximo 500 caracteres").optional() }),
);
