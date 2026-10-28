import { Router } from "express";
import healthRoutes from "./modules/health/health.routes.js";

/**
 * Builds the API router. `modules` maps a mount path to a ready router, so
 * later phases (and tests) can inject module routers with fakes:
 *   createRoutes({ modules: { "/sugerido": createSugeridoRouter(deps) } })
 */
export function createRoutes({ modules = {} } = {}) {
  const router = Router();

  // Protected modules add `authenticate` (shared/http/authSupabase.js) on
  // their own mount; health stays public.
  router.use("/health", healthRoutes);
  for (const [path, moduleRouter] of Object.entries(modules)) router.use(path, moduleRouter);

  return router;
}

export default createRoutes();
