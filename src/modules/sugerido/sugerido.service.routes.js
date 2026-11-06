import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler.js";
import { validate } from "../../shared/http/validate.js";
import { weekParamsSchema } from "./sugerido.schemas.js";

// No human behind these calls: created_by is nullable in sugerido_runs (001_sugerido.sql), so the
// system actor is stored as NULL. Access is "every sede" because the service key is all-or-nothing.
const SYSTEM_ACTOR = Object.freeze({ id: null });
const SYSTEM_ACCESS = Object.freeze({ role: "admin", sedeIds: null });

/**
 * /api/sugerido/service. Machine-to-machine endpoints for the scheduled daily recalculation.
 * Guarded only by the service key (no Supabase session) and mounted before the user routes.
 * Calls the same service methods as the user endpoints, so the calculation and the preservation
 * of overrides are identical.
 */
export function createSugeridoServiceRouter({ serviceKeyAuth, service }) {
  const router = Router();
  router.use(serviceKeyAuth);

  router.get(
    "/sedes",
    asyncHandler(async (_req, res) => res.json({ data: await service.listSedes(SYSTEM_ACCESS) })),
  );

  router.post(
    "/sedes/:sedeId/weeks/:weekStart/runs",
    validate({ params: weekParamsSchema }),
    asyncHandler(async (req, res) => {
      const { sedeId, weekStart } = req.params;
      const week = await service.computeRun(SYSTEM_ACTOR, sedeId, weekStart);
      res.status(week.run.persisted ? 201 : 200).json({
        data: {
          sedeId: week.sedeId,
          weekStart: week.weekStart,
          version: week.run.version,
          persisted: week.run.persisted,
          dataAsOf: week.freshness?.dataAsOf ?? null,
        },
      });
    }),
  );

  return router;
}
