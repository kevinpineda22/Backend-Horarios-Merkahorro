import { Router } from "express";
import healthRoutes from "./modules/health/health.routes.js";
import { getSupabase } from "./shared/supabase.js";
import { authenticate } from "./shared/http/authSupabase.js";
import { createAccessRepo } from "./shared/access/access.supabase.js";
import { createNovedadesRouter } from "./modules/novedades/novedades.routes.js";
import { createNovedadesService } from "./modules/novedades/novedades.service.js";
import { createNovedadesRepo } from "./modules/novedades/novedades.supabase.js";
import { createAccesosRouter } from "./modules/accesos/accesos.routes.js";
import { createAccesosService } from "./modules/accesos/accesos.service.js";
import { getEnv } from "./config/env.js";
import { createEmpleadosRouter } from "./modules/empleados/empleados.routes.js";
import { createEmpleadosService } from "./modules/empleados/empleados.service.js";
import { createSedeAliasRepo } from "./modules/empleados/sedeAliases.supabase.js";
import { createLazyTrazabilidadClient } from "./modules/empleados/trazabilidad.client.js";
import { createAccesosRepo, createProfilesRepo } from "./modules/accesos/accesos.supabase.js";

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
const lazyClient = {
  from: (table) => getSupabase().from(table),
  rpc: (name, args) => getSupabase().rpc(name, args),
};
const accessRepo = createAccessRepo(lazyClient);

// EMPLEADOS_CACHE_TTL_MS: non-negative integer in ms; unset/invalid falls back to the service default.
export const parseTtl = (raw) => (/^\d+$/.test(raw ?? "") ? Number(raw) : undefined);

export default createRoutes({
  modules: {
    "/novedades": createNovedadesRouter({
      authenticate,
      accessRepo,
      service: createNovedadesService({ repo: createNovedadesRepo(lazyClient) }),
    }),
    "/accesos": createAccesosRouter({
      authenticate,
      accessRepo,
      service: createAccesosService({
        repo: createAccesosRepo(lazyClient),
        profilesRepo: createProfilesRepo(lazyClient),
      }),
    }),
    "/empleados": createEmpleadosRouter({
      authenticate,
      accessRepo,
      service: createEmpleadosService({
        client: createLazyTrazabilidadClient(() => getEnv()),
        aliasRepo: createSedeAliasRepo(lazyClient),
        ttlMs: parseTtl(process.env.EMPLEADOS_CACHE_TTL_MS),
      }),
    }),
  },
});
