import { createSugeridoRouter } from "./sugerido.routes.js";
import { createSugeridoService } from "./sugerido.service.js";
import { createSalesRepo } from "./repositories/sales.pg.js";
import { createSettingsRepo } from "./repositories/settings.supabase.js";
import { createSuggestionsRepo } from "./repositories/suggestions.supabase.js";
import { createStaffPort } from "./repositories/staff.port.js";
import { createAbsencesPort } from "./repositories/absences.port.js";
import { createNovedadesRepo } from "../novedades/novedades.supabase.js";

/**
 * Composition of the /sugerido module. Nothing here opens a connection: `client` is a lazy
 * Supabase client and `getPool` is only called by the sales repository on its first query, so
 * building the module (at import time) needs no credentials and no network.
 *
 *   client             lazy Supabase client ({ from, rpc })
 *   empleadosService   the SAME instance mounted at /empleados, so both share one directory cache
 *   getPool            () => pg pool for the sales database; may throw when POSTGRES_* is missing
 *
 * A missing POSTGRES_* configuration surfaces inside the sales query as 503 SALES_DB_UNAVAILABLE;
 * a missing TRAZABILIDAD_* configuration as 503 STAFF_SOURCE_UNAVAILABLE (see the empleados client).
 */
export function createSugeridoModule({ authenticate, accessRepo, client, empleadosService, getPool, now }) {
  const suggestionsRepo = createSuggestionsRepo(client);
  const service = createSugeridoService({
    suggestionsRepo,
    settingsRepo: createSettingsRepo(client),
    // connect() is invoked inside the repository's try block, so a throwing getPool() is mapped
    // to SALES_DB_UNAVAILABLE like any other connection failure.
    salesRepo: createSalesRepo({ connect: () => getPool().connect() }),
    staffPort: createStaffPort(empleadosService, suggestionsRepo),
    absencesPort: createAbsencesPort(createNovedadesRepo(client)),
    ...(now ? { now } : {}),
  });
  return createSugeridoRouter({ authenticate, accessRepo, service });
}
