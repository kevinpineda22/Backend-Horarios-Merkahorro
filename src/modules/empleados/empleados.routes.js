import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/http/asyncHandler.js";
import { validate } from "../../shared/http/validate.js";
import { loadAccess, requireRole } from "../../shared/http/authorize.js";
import { isValidCedula } from "../../shared/cedula.js";

const filter = (max) => z.string().trim().min(1, "Filtro vacío").max(max, "Filtro demasiado largo").optional();

export const listQuerySchema = z.object({ sede: filter(100), cargo: filter(100), q: filter(100) });

export const exclusionParamsSchema = z.object({
  cedula: z.string().trim().refine(isValidCedula, "Cédula inválida"),
});

// motivo: trimmed, optional, blank means none. It is only stored when the employee is being excluded.
export const exclusionBodySchema = z.object({
  excluido: z.boolean({ required_error: "excluido es obligatorio", invalid_type_error: "excluido debe ser verdadero o falso" }),
  motivo: z
    .string({ invalid_type_error: "El motivo debe ser texto" })
    .trim()
    .max(200, "El motivo no puede superar 200 caracteres")
    .nullish()
    .transform((v) => v || null),
});

/**
 * GET /api/empleados. Order: authenticate -> loadAccess -> requireRole -> validate.
 * Any role with an access row can read; each caller only sees rows of its sedes.
 */
export function createEmpleadosRouter({ authenticate, accessRepo, service }) {
  const router = Router();

  router.use(authenticate, loadAccess(accessRepo), requireRole("viewer", "planner", "admin"));

  router.get(
    "/",
    validate({ query: listQuerySchema }),
    asyncHandler(async (req, res) => res.json(await service.list(req.access, req.query))),
  );

  // "Solo surtidor / no programar en caja": admin anywhere, planner only for their sedes (the service decides).
  router.put(
    "/:cedula/exclusion-caja",
    requireRole("admin", "planner"),
    validate({ params: exclusionParamsSchema, body: exclusionBodySchema }),
    asyncHandler(async (req, res) =>
      res.json({ data: await service.setExclusion(req.access, req.user, req.params.cedula, req.body) }),
    ),
  );

  return router;
}
