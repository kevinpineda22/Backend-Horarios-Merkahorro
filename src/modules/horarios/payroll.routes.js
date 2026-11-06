import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler.js";
import { validate } from "../../shared/http/validate.js";
import { loadAccess, requireRole, requireSede } from "../../shared/http/authorize.js";
import {
  cutParamsSchema,
  cutQuerySchema,
  cutsQuerySchema,
  reportQuerySchema,
  saveCutBodySchema,
  voidCutBodySchema,
} from "./payroll.schemas.js";

/**
 * /api/horarios/payroll. Dependencies are injected so tests run with fakes:
 *   authenticate  Express middleware setting req.user
 *   accessRepo    { findByUserId(userId) } over sugerido_access
 *   service       createPayrollService(...)
 * Order per route: authenticate -> loadAccess -> requireRole(admin, planner) -> validate -> requireSede(query.sedeId).
 * Payroll data is sensitive: viewers are denied. Without sedeId the service filters rows by the caller's sedes.
 */
export function createPayrollRouter({ authenticate, accessRepo, service }) {
  const router = Router();
  const readers = requireRole("admin", "planner");
  // Only checked when the caller narrows the report to one sede.
  const sede = (req, res, next) =>
    req.query.sedeId === undefined ? next() : requireSede((r) => r.query.sedeId)(req, res, next);

  router.use(authenticate, loadAccess(accessRepo));

  router.get(
    "/report",
    readers,
    validate({ query: reportQuerySchema }),
    sede,
    asyncHandler(async (req, res) => res.json(await service.report(req.access, req.query))),
  );

  // Cuts: everyone with payroll access reads them; only admins save or void.
  const admins = requireRole("admin");

  router.get(
    "/cuts",
    readers,
    validate({ query: cutsQuerySchema }),
    asyncHandler(async (req, res) => res.json(await service.listCuts(req.access, req.query))),
  );

  router.get(
    "/cuts/:id",
    readers,
    validate({ params: cutParamsSchema, query: cutQuerySchema }),
    sede,
    asyncHandler(async (req, res) => res.json(await service.getCut(req.access, req.params.id, req.query))),
  );

  router.post(
    "/cuts",
    admins,
    validate({ body: saveCutBodySchema }),
    asyncHandler(async (req, res) => res.status(201).json(await service.saveCut(req.access, req.user, req.body))),
  );

  router.post(
    "/cuts/:id/void",
    admins,
    validate({ params: cutParamsSchema, body: voidCutBodySchema }),
    asyncHandler(async (req, res) => res.json(await service.voidCut(req.access, req.user, req.params.id, req.body))),
  );

  return router;
}
