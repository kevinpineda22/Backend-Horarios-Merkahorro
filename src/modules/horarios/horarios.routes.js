import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler.js";
import { validate } from "../../shared/http/validate.js";
import { loadAccess, requireRole, requireSede } from "../../shared/http/authorize.js";
import { historyQuerySchema, publishBodySchema, saveBodySchema, schedulesListQuerySchema, snapshotParamsSchema, snapshotsListQuerySchema, unpublishBodySchema, sedeParamsSchema, weekParamsSchema } from "./horarios.schemas.js";

/**
 * /api/horarios. Dependencies are injected so tests run with fakes:
 *   authenticate  Express middleware setting req.user
 *   accessRepo    { findByUserId(userId) } over sugerido_access
 *   service       createHorariosService(...)
 * Order per route: authenticate -> loadAccess -> requireRole -> validate -> requireSede(params.sedeId).
 * A scoped user hitting another sede gets 403 before the service looks the sede up; the
 * service answers 404 SEDE_NOT_FOUND for admins and unscoped users.
 */
export function createHorariosRouter({ authenticate, accessRepo, service }) {
  const router = Router();
  const writers = requireRole("admin", "planner");
  const readers = requireRole("admin", "planner", "viewer");
  const sede = requireSede((req) => req.params.sedeId);
  const base = "/sedes/:sedeId/weeks/:weekStart";

  router.use(authenticate, loadAccess(accessRepo));

  // Schedules (weeks) of a sede by state, for the "Horarios publicados" screen.
  router.get(
    "/sedes/:sedeId/schedules",
    readers,
    validate({ params: sedeParamsSchema, query: schedulesListQuerySchema }),
    sede,
    asyncHandler(async (req, res) =>
      res.json({ data: await service.listSchedules(req.access, req.params.sedeId, req.query) }),
    ),
  );

  router.get(
    `${base}/shifts`,
    readers,
    validate({ params: weekParamsSchema }),
    sede,
    asyncHandler(async (req, res) => res.json(await service.get(req.access, req.params.sedeId, req.params.weekStart))),
  );

  router.put(
    `${base}/shifts`,
    writers,
    validate({ params: weekParamsSchema, body: saveBodySchema }),
    sede,
    asyncHandler(async (req, res) =>
      res.json(await service.save(req.access, req.user, req.params.sedeId, req.params.weekStart, req.body)),
    ),
  );

  router.post(
    `${base}/publish`,
    writers,
    validate({ params: weekParamsSchema, body: publishBodySchema }),
    sede,
    asyncHandler(async (req, res) =>
      res.json(await service.publish(req.access, req.user, req.params.sedeId, req.params.weekStart, req.body)),
    ),
  );

  // Back to BORRADOR: same roles and sede access as publish. Answers { data: { schedule }, warnings }.
  router.post(
    `${base}/unpublish`,
    writers,
    validate({ params: weekParamsSchema, body: unpublishBodySchema }),
    sede,
    asyncHandler(async (req, res) => {
      const { schedule, warnings } = await service.unpublish(req.access, req.user, req.params.sedeId, req.params.weekStart, req.body);
      res.json({ data: { schedule }, warnings });
    }),
  );

  // Publish snapshots (recommended vs suggested vs published): admins only, it is the follow-up of how leaders publish.
  const admins = requireRole("admin");
  router.get(
    "/sedes/:sedeId/snapshots",
    admins,
    validate({ params: sedeParamsSchema, query: snapshotsListQuerySchema }),
    sede,
    asyncHandler(async (req, res) => res.json({ data: await service.listSnapshots(req.access, req.params.sedeId, req.query) })),
  );
  router.get(
    "/sedes/:sedeId/snapshots/:snapshotId",
    admins,
    validate({ params: snapshotParamsSchema }),
    sede,
    asyncHandler(async (req, res) => res.json({ data: await service.getSnapshot(req.access, req.params.sedeId, req.params.snapshotId) })),
  );

  router.get(
    `${base}/history`,
    readers,
    validate({ params: weekParamsSchema, query: historyQuerySchema }),
    sede,
    asyncHandler(async (req, res) =>
      res.json(await service.history(req.access, req.params.sedeId, req.params.weekStart, req.query.limit)),
    ),
  );

  return router;
}
