import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/http/asyncHandler.js";
import { validate } from "../../shared/http/validate.js";
import { loadAccess, requireRole, requireSede } from "../../shared/http/authorize.js";
import { isoDow, toEpochDay } from "../sugerido/domain/dates.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isMonday = (value) => {
  try {
    toEpochDay(value);
    return isoDow(value) === 1;
  } catch {
    return false;
  }
};

export const weekParamsSchema = z.object({
  sedeId: z.string().trim().min(1, "Sede inválida"),
  weekStart: z.string().regex(DATE_RE, "Fecha inválida (YYYY-MM-DD)").refine(isMonday, "weekStart debe ser un lunes válido (YYYY-MM-DD)"),
});

// Hours in half-hour steps, more than 0 and at most 100; a reason is mandatory.
export const requestBodySchema = z.object({
  hours: z
    .number({ required_error: "Indica cuántas horas extra necesitas", invalid_type_error: "Las horas deben ser un número" })
    .positive("Las horas deben ser mayores a 0")
    .max(100, "No puedes pedir más de 100 horas")
    .refine((n) => Number.isInteger(n * 2), "Las horas van en pasos de media hora"),
  motivo: z.string({ required_error: "El motivo es obligatorio" }).trim().min(1, "El motivo es obligatorio").max(500, "El motivo no puede superar 500 caracteres"),
});

export const decisionBodySchema = z.object({
  decision: z.enum(["APROBADA", "RECHAZADA"], { errorMap: () => ({ message: "La decisión debe ser APROBADA o RECHAZADA" }) }),
  comment: z.string().trim().max(500, "El comentario no puede superar 500 caracteres").nullish().transform((v) => v || null),
});

export const listQuerySchema = z.object({
  status: z.enum(["PENDIENTE", "APROBADA", "RECHAZADA"]).optional(),
});

export const requestIdSchema = z.object({ id: z.string().uuid("Id inválido") });

/**
 * /api/overtime. Leaders (sugerido_access admin/planner) ask for and read the requests of a sede-week. The approvers are
 * identified by their e-mail (they may have no access row in the scheduler), so their routes only authenticate.
 */
export function createOvertimeRouter({ authenticate, accessRepo, service }) {
  const router = Router();
  const withAccess = [loadAccess(accessRepo)];
  const sede = requireSede((req) => req.params.sedeId);
  const base = "/sedes/:sedeId/weeks/:weekStart";

  router.use(authenticate);

  router.get("/me", asyncHandler(async (req, res) => res.json({ data: await service.me(req.user) })));

  router.get(
    base,
    ...withAccess,
    requireRole("admin", "planner", "viewer"),
    validate({ params: weekParamsSchema }),
    sede,
    asyncHandler(async (req, res) => res.json({ data: await service.forWeek(req.access, req.params.sedeId, req.params.weekStart) })),
  );

  router.post(
    base,
    ...withAccess,
    requireRole("admin", "planner"),
    validate({ params: weekParamsSchema, body: requestBodySchema }),
    sede,
    asyncHandler(async (req, res) =>
      res.status(201).json({ data: await service.request(req.access, req.user, req.params.sedeId, req.params.weekStart, req.body) }),
    ),
  );

  router.get(
    "/requests",
    validate({ query: listQuerySchema }),
    asyncHandler(async (req, res) => res.json({ data: await service.listForApprovers(req.user, req.query) })),
  );

  router.post(
    "/requests/:id/decision",
    validate({ params: requestIdSchema, body: decisionBodySchema }),
    asyncHandler(async (req, res) => res.json({ data: await service.decide(req.user, req.params.id, req.body) })),
  );

  return router;
}
