import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler.js";
import { validate } from "../../shared/http/validate.js";
import { loadAccess, requireRole, requireSede } from "../../shared/http/authorize.js";
import { reportQuerySchema } from "./payroll.schemas.js";

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

  return router;
}
