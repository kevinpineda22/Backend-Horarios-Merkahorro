import { Router } from "express";
import healthRoutes from "./modules/health/health.routes.js";
import { getSupabase } from "./shared/supabase.js";
import { authenticate } from "./shared/http/authSupabase.js";
import { createAccessRepo } from "./shared/access/access.supabase.js";
import { createNovedadesRouter } from "./modules/novedades/novedades.routes.js";
import { createNovedadesService } from "./modules/novedades/novedades.service.js";
import { createNovedadesRepo } from "./modules/novedades/novedades.supabase.js";

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

// Composition root. The Supabase client is created on the first query, never at import time.
const lazyClient = { from: (table) => getSupabase().from(table) };

export default createRoutes({
  modules: {
    "/novedades": createNovedadesRouter({
      authenticate,
      accessRepo: createAccessRepo(lazyClient),
      service: createNovedadesService({ repo: createNovedadesRepo(lazyClient) }),
    }),
  },
});
