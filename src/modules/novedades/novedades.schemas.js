import { z } from "zod";
import { toEpochDay } from "../sugerido/domain/dates.js";
import { NOVEDAD_TYPES } from "./domain/novedadTypes.js";

const required = (label) => ({ required_error: `${label} es obligatorio` });

// Real calendar date as 'YYYY-MM-DD' (rejects 2026-02-30 and datetime strings).
const dateOnly = z.string(required("La fecha")).refine(
  (v) => {
    try {
      toEpochDay(v);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Fecha inválida (use AAAA-MM-DD)" },
);

// Trim, strip separators (spaces, dots, commas, dashes), then require 5-15 digits.
const cedula = z
  .string(required("La cédula"))
  .transform((v) => v.replace(/[\s.,-]/g, ""))
  .refine((v) => /^[0-9]{5,15}$/.test(v), { message: "Cédula inválida (5 a 15 dígitos)" });

// Normalize to NFC so "Día" sent in decomposed form (NFD) matches the canonical label.
const tipo = z.preprocess(
  (v) => (typeof v === "string" ? v.normalize("NFC") : v),
  z.enum(NOVEDAD_TYPES, { errorMap: () => ({ message: "Tipo de novedad inválido" }) }),
);

const observacion = z
  .string()
  .max(1000, "La observación no puede superar 1000 caracteres")
  .nullable()
  .transform((v) => (v == null || v.trim() === "" ? null : v.trim()));

const sedeId = z.string().min(1, "Sede inválida").nullable();

const rangeOk = (d) => !d.fechaInicio || !d.fechaFin || d.fechaFin >= d.fechaInicio;
const rangeIssue = { message: "fechaFin no puede ser anterior a fechaInicio", path: ["fechaFin"] };

export const createNovedadSchema = z
  .object({
    cedula,
    tipo,
    fechaInicio: dateOnly,
    fechaFin: dateOnly,
    observacion: observacion.optional().default(null),
    sedeId: sedeId.optional().default(null),
  })
  .refine(rangeOk, rangeIssue);

export const patchNovedadSchema = z
  .object({
    cedula,
    tipo,
    fechaInicio: dateOnly,
    fechaFin: dateOnly,
    observacion,
    sedeId,
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "Debes enviar al menos un campo" })
  .refine(rangeOk, rangeIssue);

export const anularSchema = z.object({
  motivo: z
    .string(required("El motivo"))
    .transform((v) => v.trim())
    .refine((v) => v.length >= 1 && v.length <= 500, { message: "El motivo debe tener entre 1 y 500 caracteres" }),
});

export const listQuerySchema = z
  .object({
    sede: z.string().min(1).optional(),
    cedula: cedula.optional(),
    desde: dateOnly.optional(),
    hasta: dateOnly.optional(),
    tipo: tipo.optional(),
    incluirAnuladas: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v === "true"),
  })
  .refine((q) => !q.desde || !q.hasta || q.hasta >= q.desde, {
    message: "hasta no puede ser anterior a desde",
    path: ["hasta"],
  });

export const idParamSchema = z.object({ id: z.string().uuid("Identificador inválido") });
