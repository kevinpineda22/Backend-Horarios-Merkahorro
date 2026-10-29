import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler.js";
import { validate } from "../../shared/http/validate.js";
import { loadAccess, requireRole, requireSede } from "../../shared/http/authorize.js";
import { createOverridesBodySchema, weekParamsSchema } from "./sugerido.schemas.js";

/**
 * /api/sugerido. Dependencies are injected so tests run with fakes:
 *   authenticate  Express middleware setting req.user
 *   accessRepo    { findByUserId(userId) } over sugerido_access
 *   service       createSugeridoService(...)
 * Order per route: authenticate -> loadAccess -> requireRole -> validate -> requireSede, so a
 * forbidden role never learns about validation details and a bad request never reaches a source.
 */
export function createSugeridoRouter({ authenticate, accessRepo, service }) {
  const router = Router();
  const writers = requireRole("admin", "planner");
  const readers = requireRole("admin", "planner", "viewer");
  const sedeOf = (req) => req.params.sedeId;
  // The body schema depends on the week in the URL (override dates must fall inside it).
  const validateOverrides = (req, res, next) =>
    validate({ params: weekParamsSchema, body: createOverridesBodySchema(req.params.weekStart) })(req, res, next);

  router.use(authenticate, loadAccess(accessRepo));

  router.get(
    "/sedes",
    readers,
    asyncHandler(async (req, res) => res.json({ data: await service.listSedes(req.access) })),
  );

  router.get(
    "/sedes/:sedeId/weeks/:weekStart",
    readers,
    validate({ params: weekParamsSchema }),
    requireSede(sedeOf),
    asyncHandler(async (req, res) => {
      const { sedeId, weekStart } = req.params;
      res.json({ data: await service.getWeek(req.user, sedeId, weekStart) });
    }),
  );

  router.post(
    "/sedes/:sedeId/weeks/:weekStart/runs",
    writers,
    validate({ params: weekParamsSchema }),
    requireSede(sedeOf),
    asyncHandler(async (req, res) => {
      const { sedeId, weekStart } = req.params;
      const week = await service.computeRun(req.user, sedeId, weekStart);
      // A week without any sales history yields zeros that are NOT saved (the save RPC rejects zero
      // slots), so it answers 200; 201 is reserved for runs that were persisted.
      res.status(week.run.persisted ? 201 : 200).json({ data: week });
    }),
  );

  router.put(
    "/sedes/:sedeId/weeks/:weekStart/overrides",
    writers,
    validateOverrides,
    requireSede(sedeOf),
    asyncHandler(async (req, res) => {
      const { sedeId, weekStart } = req.params;
      res.json({ data: await service.saveOverrides(req.user, sedeId, weekStart, req.body) });
    }),
  );

  return router;
}
