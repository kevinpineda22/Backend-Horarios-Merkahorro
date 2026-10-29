import { z } from "zod";

const required = (label) => ({ required_error: `${label} es obligatorio` });

export const ACCESS_ROLES = Object.freeze(["admin", "planner", "viewer"]);

const role = z.enum(ACCESS_ROLES, { errorMap: () => ({ message: "Rol inválido" }) });
const userId = z.string(required("El usuario")).uuid("Usuario inválido");

// null = every sede; otherwise a non-empty, de-duplicated list of sede ids.
// Existence in sugerido_sedes is checked by the service (needs the database).
const sedeIds = z
  .array(z.string().trim().min(1, "Sede inválida"), { invalid_type_error: "sedeIds debe ser null o una lista" })
  .min(1, "sedeIds no puede estar vacío (use null para todas las sedes)")
  .transform((ids) => [...new Set(ids)])
  .nullable();

// Audit fields (created_by, ...) are not part of the schema: zod strips them from the body.
export const createAccessSchema = z.object({
  userId,
  role,
  sedeIds: sedeIds.refine((v) => v !== undefined, { message: "sedeIds es obligatorio" }),
});

export const patchAccessSchema = z
  .object({ role, sedeIds })
  .partial()
  .refine((d) => d.role !== undefined || d.sedeIds !== undefined, { message: "Debes enviar al menos un campo" });

export const listQuerySchema = z.object({
  incluirRevocados: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export const lookupQuerySchema = z.object({
  q: z
    .string(required("La búsqueda"))
    .trim()
    .min(2, "La búsqueda debe tener al menos 2 caracteres")
    .max(100, "La búsqueda no puede superar 100 caracteres"),
});

export const idParamSchema = z.object({ id: z.string().uuid("Identificador inválido") });
