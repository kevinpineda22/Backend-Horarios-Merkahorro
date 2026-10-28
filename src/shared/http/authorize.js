import { createHttpError } from "./HttpError.js";

/**
 * Role and sede authorization over `sugerido_access` (user_id, role, sede_ids).
 *
 * The repository is injected (`findByUserId(userId) -> { role, sede_ids } | null`)
 * so these middlewares are unit-testable offline. `sede_ids` null means every sede.
 * Stable error codes: AUTH_REQUIRED (401), FORBIDDEN_ROLE (403), FORBIDDEN_SEDE (403).
 */

const ROLES = Object.freeze(["admin", "planner", "viewer"]);

const forbiddenRole = () =>
  createHttpError(403, "No tienes permisos para realizar esta acción.", "FORBIDDEN_ROLE");
const forbiddenSede = () =>
  createHttpError(403, "No tienes acceso a esta sede.", "FORBIDDEN_SEDE");

/** Admins see everything; a null sede is admin-only; a null sede list means every sede. */
export function canAccessSede(access, sedeId) {
  if (!access) return false;
  if (access.role === "admin") return true;
  if (sedeId == null) return false;
  return access.sedeIds == null || access.sedeIds.includes(sedeId);
}

/** Loads the caller's access row into `req.access = { role, sedeIds }`. */
export function loadAccess(accessRepo) {
  return async function loadAccessMiddleware(req, _res, next) {
    if (!req.user?.id) {
      return next(createHttpError(401, "Debes iniciar sesión para usar esta función.", "AUTH_REQUIRED"));
    }
    try {
      const row = await accessRepo.findByUserId(req.user.id);
      // A revoked row is never valid, even if a repository returns it.
      if (!row || row.revoked_at || !ROLES.includes(row.role)) return next(forbiddenRole());
      req.access = Object.freeze({ role: row.role, sedeIds: row.sede_ids ?? null });
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export function requireRole(...roles) {
  return function requireRoleMiddleware(req, _res, next) {
    if (!req.access || !roles.includes(req.access.role)) return next(forbiddenRole());
    return next();
  };
}

/** `getSedeId(req)` may be sync or async and returns the sede the request targets. */
export function requireSede(getSedeId) {
  return async function requireSedeMiddleware(req, _res, next) {
    if (!req.access) return next(forbiddenRole());
    try {
      const sedeId = await getSedeId(req);
      return canAccessSede(req.access, sedeId) ? next() : next(forbiddenSede());
    } catch (err) {
      return next(err);
    }
  };
}
