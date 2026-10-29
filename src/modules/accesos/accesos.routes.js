import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler.js";
import { validate } from "../../shared/http/validate.js";
import { loadAccess, requireRole } from "../../shared/http/authorize.js";
import {
  createAccessSchema,
  idParamSchema,
  listQuerySchema,
  lookupQuerySchema,
  patchAccessSchema,
} from "./accesos.schemas.js";

/**
 * /api/accesos (admin only, spec R8.1). Dependencies are injected so tests run with fakes:
 *   authenticate  Express middleware setting req.user
 *   accessRepo    { findByUserId(userId) } over sugerido_access
 *   service       createAccesosService(...)
 * Order per route: authenticate -> loadAccess -> requireRole('admin') -> validate.
 */
export function createAccesosRouter({ authenticate, accessRepo, service }) {
  const router = Router();

  router.use(authenticate, loadAccess(accessRepo), requireRole("admin"));

  router.get(
    "/",
    validate({ query: listQuerySchema }),
    asyncHandler(async (req, res) => res.json(await service.list(req.query))),
  );

  // Declared before any "/:id" route so "usuarios" is never read as an id.
  router.get(
    "/usuarios",
    validate({ query: lookupQuerySchema }),
    asyncHandler(async (req, res) => res.json(await service.searchUsers(req.query.q))),
  );

  router.post(
    "/",
    validate({ body: createAccessSchema }),
    asyncHandler(async (req, res) => res.status(201).json(await service.create(req.user, req.body))),
  );

  router.patch(
    "/:id",
    validate({ params: idParamSchema, body: patchAccessSchema }),
    asyncHandler(async (req, res) => res.json(await service.update(req.user, req.params.id, req.body))),
  );

  router.post(
    "/:id/revocar",
    validate({ params: idParamSchema }),
    asyncHandler(async (req, res) => res.json(await service.revoke(req.user, req.params.id))),
  );

  return router;
}
