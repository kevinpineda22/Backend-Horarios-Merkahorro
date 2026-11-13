import { Router } from "express";
import { asyncHandler } from "../../shared/http/asyncHandler.js";
import { validate } from "../../shared/http/validate.js";
import { createRateLimiter } from "../../shared/http/rateLimit.js";
import { consultaBodySchema } from "./publicSchedule.schemas.js";

/**
 * /api/public/horarios: PUBLIC (no authenticate, no Supabase token) schedule lookup for employees.
 * Rate limiter first: it rejects clients over the failure quota and counts 400/404 responses (not 200s); then body validation.
 * POST (not GET) keeps the cedula out of URLs and access logs.
 */
export function createPublicScheduleRouter({ service, rateLimit = createRateLimiter() }) {
  const router = Router();

  router.post(
    "/consulta",
    rateLimit,
    validate({ body: consultaBodySchema }),
    asyncHandler(async (req, res) => res.json(await service.consulta(req.body))),
  );

  return router;
}
