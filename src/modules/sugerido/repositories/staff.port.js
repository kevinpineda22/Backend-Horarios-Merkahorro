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
export const CASHIER_CARGOS = Object.freeze(["cajera", "cajero", "cajero (a)", "cajero - surtidor"]);

/** Fold accents/case, collapse whitespace and normalize the spacing around hyphens. */
const normalizeCargo = (value) => fold(value).replace(/\s*-\s*/g, " - ");

const STOCKER_CARGO = "cajero - surtidor";

/** True for the cashier cargos of the allowlist above. */
export const isCashierCargo = (cargo) => CASHIER_CARGOS.includes(normalizeCargo(cargo));

const notMapped = () =>
  createHttpError(404, "La sede no está configurada para el sugerido.", "SEDE_NOT_MAPPED");

const unavailable = () =>
  createHttpError(503, "Employee directory is temporarily unavailable", "STAFF_SOURCE_UNAVAILABLE");

/**
 * Would this directory row be a schedulable cashier? Same rules wherever she works: "Programar en caja" always counts;
 * "Solo surtidor" and pre-contractual people (without that mark) never do; otherwise the cashier cargo allowlist decides.
 */
function isSchedulableCashier(row) {
  if (row?.activo !== true) return false;
  // "Programar en caja": another cargo in SIESA, but the leader says she works the register.
  if (row.incluidoEnCaja === true) return true;
  // "Solo surtidor": SIESA says cashier, the leader says she does not work the register (yet).
  if (row.excluidoDeCaja === true) return false;
  // No contract yet: only whoever the leader marked "Programar en caja" counts.
  if (row.precontractual === true) return false;
  return CASHIER_CARGOS.includes(normalizeCargo(row.cargo));
}

/**
 * Staff port over the empleados service. `sedeRepo.getSede` is the sugerido_sedes lookup
 * (throws 404 SEDE_NOT_MAPPED for an unknown sede). `loansRepo` (optional, migration 016) makes the pool aware of employee
 * loans between sedes. Errors from the directory or the loans propagate untouched: a failing source is never turned into
 * an empty pool.
 */
export function createStaffPort(empleadosService, sedeRepo, loansRepo = null) {
  if (typeof empleadosService?.list !== "function") throw new Error("empleadosService with list() is required");
  if (typeof sedeRepo?.getSede !== "function") throw new Error("sedeRepo with getSede() is required");

  return {
    /** Cedulas of every active cajero-surtidor, of any sede (somebody may have moved since the week being read). */
    async listStockerCedulas() {
      const result = await empleadosService.list(SERVICE_ACCESS, { precontractuales: true });
      if (!Array.isArray(result?.data)) throw unavailable();
      return new Set(result.data.filter((row) => row?.activo === true && normalizeCargo(row.cargo) === STOCKER_CARGO).map((row) => normalizeCedula(row.cedula)).filter(Boolean));
    },

    /**
     * Active cashiers of the sede as [{ cedula }] (normalized, unique). With `weekStart` the pool follows the employee
     * loans of that week: people lent OUT of the sede leave it, people lent IN join it (if they would be schedulable
     * cashiers by the rules above). Without a week (or without a loans repo) the loans are ignored.
     */
    async getCashierPool(sedeId, weekStart = null) {
      if (typeof sedeId !== "string" || sedeId.trim() === "") throw notMapped();
      await sedeRepo.getSede(sedeId);

      const loans = loansRepo && weekStart ? await loansRepo.listActiveByWeek(weekStart) : [];
      const lentOut = new Set(loans.filter((l) => l.homeSedeId === sedeId).map((l) => normalizeCedula(l.cedula)));
      const lentIn = new Set(loans.filter((l) => l.hostSedeId === sedeId).map((l) => normalizeCedula(l.cedula)));

      const result = await empleadosService.list(SERVICE_ACCESS, { sede: sedeId, precontractuales: true });
      if (!Array.isArray(result?.data)) throw unavailable();

      const cedulas = new Set();
      for (const row of result.data) {
        if (row?.sedeId !== sedeId || !isSchedulableCashier(row)) continue;
        const cedula = normalizeCedula(row.cedula);
        if (cedula && !lentOut.has(cedula)) cedulas.add(cedula);
      }

      if (lentIn.size > 0) {
        // They belong to another sede in the directory, so the sede-filtered list above does not have them.
        const everyone = await empleadosService.list(SERVICE_ACCESS, { precontractuales: true });
        if (!Array.isArray(everyone?.data)) throw unavailable();
        for (const row of everyone.data) {
          const cedula = normalizeCedula(row?.cedula);
          if (cedula && lentIn.has(cedula) && isSchedulableCashier(row)) cedulas.add(cedula);
        }
      }
      return [...cedulas].map((cedula) => ({ cedula }));
    },
  };
}
