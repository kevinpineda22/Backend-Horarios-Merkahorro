import { createHttpError } from "../../../shared/http/HttpError.js";
import { normalizeCedula } from "../../../shared/cedula.js";
import { normalizeSedeAlias as fold } from "../../../shared/sedeAlias.js";

// Internal, service-level access: the suggestion run reads the whole directory on behalf of
// the system, not of the requesting user (whose own scope is enforced by the routes).
// Never built from a request, so a user token or sede scope can never leak into it.
const SERVICE_ACCESS = Object.freeze({ role: "admin", sedeIds: null });

// Cashier cargo rule: EXACT allowlist of normalized cargos (decision: cashier cargo allowlist).
// Not a substring match: "CAJERO PAC", "Jefe de cajeros", "Cajera principal" are excluded.
// A new cargo must be added here deliberately.
export const CASHIER_CARGOS = Object.freeze(["cajera", "cajero", "cajero - surtidor"]);

/** Fold accents/case, collapse whitespace and normalize the spacing around hyphens. */
const normalizeCargo = (value) => fold(value).replace(/\s*-\s*/g, " - ");

const notMapped = () =>
  createHttpError(404, "La sede no está configurada para el sugerido.", "SEDE_NOT_MAPPED");

const unavailable = () =>
  createHttpError(503, "Employee directory is temporarily unavailable", "STAFF_SOURCE_UNAVAILABLE");

/**
 * Staff port over the empleados service. `sedeRepo.getSede` is the sugerido_sedes lookup
 * (throws 404 SEDE_NOT_MAPPED for an unknown sede). Errors from the directory propagate
 * untouched: a failing source is never turned into an empty pool.
 */
export function createStaffPort(empleadosService, sedeRepo) {
  if (typeof empleadosService?.list !== "function") throw new Error("empleadosService with list() is required");
  if (typeof sedeRepo?.getSede !== "function") throw new Error("sedeRepo with getSede() is required");

  return {
    /** Active cashiers of the sede as [{ cedula }] (normalized, unique). */
    async getCashierPool(sedeId) {
      if (typeof sedeId !== "string" || sedeId.trim() === "") throw notMapped();
      await sedeRepo.getSede(sedeId);

      const result = await empleadosService.list(SERVICE_ACCESS, { sede: sedeId });
      if (!Array.isArray(result?.data)) throw unavailable();

      const cedulas = new Set();
      for (const row of result.data) {
        if (row?.activo !== true || row.sedeId !== sedeId) continue;
        if (!CASHIER_CARGOS.includes(normalizeCargo(row.cargo))) continue;
        const cedula = normalizeCedula(row.cedula);
        if (cedula) cedulas.add(cedula);
      }
      return [...cedulas].map((cedula) => ({ cedula }));
    },
  };
}
