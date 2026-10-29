import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/http/asyncHandler.js";
import { validate } from "../../shared/http/validate.js";
import { loadAccess, requireRole } from "../../shared/http/authorize.js";

const filter = (max) => z.string().trim().min(1, "Filtro vacío").max(max, "Filtro demasiado largo").optional();

export const listQuerySchema = z.object({ sede: filter(100), cargo: filter(100), q: filter(100) });

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

  return router;
}
