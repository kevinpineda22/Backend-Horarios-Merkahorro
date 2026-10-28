import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler.js";
import { validate } from "../../shared/http/validate.js";
import { loadAccess, requireRole, requireSede } from "../../shared/http/authorize.js";
import {
  anularSchema,
  createNovedadSchema,
  idParamSchema,
  listQuerySchema,
  patchNovedadSchema,
} from "./novedades.schemas.js";

/**
 * /api/novedades. Dependencies are injected so tests run with fakes:
 *   authenticate  Express middleware setting req.user
 *   accessRepo    { findByUserId(userId) } over sugerido_access
 *   service       createNovedadesService(...)
 * Order per route: authenticate -> loadAccess -> requireRole -> validate -> requireSede,
 * so a forbidden role never learns about validation details. Existing-row scoping is
 * enforced by the service (it needs the stored sede).
 */
export function createNovedadesRouter({ authenticate, accessRepo, service }) {
  const router = Router();
  const writers = requireRole("admin", "planner");
  const readers = requireRole("admin", "planner", "viewer");

  router.use(authenticate, loadAccess(accessRepo));

  router.get(
    "/",
    readers,
    validate({ query: listQuerySchema }),
    asyncHandler(async (req, res) => res.json(await service.list(req.access, req.query))),
  );

  router.get(
    "/:id",
    readers,
    validate({ params: idParamSchema }),
    asyncHandler(async (req, res) => res.json(await service.get(req.access, req.params.id))),
  );

  router.post(
    "/",
    writers,
    validate({ body: createNovedadSchema }),
    requireSede((req) => req.body.sedeId),
    asyncHandler(async (req, res) =>
      res.status(201).json(await service.create(req.access, req.user, req.body)),
    ),
  );

  router.patch(
    "/:id",
    writers,
    validate({ params: idParamSchema, body: patchNovedadSchema }),
    asyncHandler(async (req, res) =>
      res.json(await service.update(req.access, req.user, req.params.id, req.body)),
    ),
  );

  router.post(
    "/:id/anular",
    writers,
    validate({ params: idParamSchema, body: anularSchema }),
    asyncHandler(async (req, res) =>
      res.json(await service.anular(req.access, req.user, req.params.id, req.body)),
    ),
  );

  return router;
}
