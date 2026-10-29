import { filterForAccess, mapEmpleados } from "./domain/empleados.js";
import { canAccessSede } from "../../shared/http/authorize.js";
import { HttpError, createHttpError } from "../../shared/http/HttpError.js";
import { normalizeCedula } from "../../shared/cedula.js";
import { normalizeSedeAlias as fold } from "../../shared/sedeAlias.js";

const DEFAULT_TTL_MS = 300000;

const unavailable = () =>
  createHttpError(503, "Employee directory is temporarily unavailable", "STAFF_SOURCE_UNAVAILABLE");

/**
 * Employee directory. The MAPPED result (not a per-user view) is cached in memory for
 * `ttlMs`; each caller is filtered afterwards. Concurrent cold requests share one load
 * (single-flight). Failures are never cached and never turn into an empty list: an
 * expired entry is not served stale, the caller gets 503 STAFF_SOURCE_UNAVAILABLE.
 * Mapping counters are logged (counts only, no PII).
 */
export function createEmpleadosService({
  client,
  aliasRepo,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
  logger = console,
}) {
  let cache = null; // { value: { rows, actualizado }, expiresAt }
  let inflight = null;

  async function load() {
    try {
      const [source, aliasMap] = await Promise.all([client.fetchEmpleadosActivos(), aliasRepo.loadAliasMap()]);
      const { rows, dropped, duplicates, conflicts, inactive } = mapEmpleados(source.data, aliasMap);
      logger?.info?.("[empleados] directory loaded", { rows: rows.length, dropped, duplicates, conflicts, inactive });
      const actualizado = source.actualizado ?? new Date(now()).toISOString();
      // Frozen: the cached directory is shared by every caller and must not be mutated by one of them.
      const value = Object.freeze({ rows: Object.freeze(rows.map((row) => Object.freeze(row))), actualizado });
      if (ttlMs > 0) cache = { value, expiresAt: now() + ttlMs };
      return value;
    } catch (err) {
      throw err instanceof HttpError ? err : unavailable();
    }
  }

  async function getDirectory() {
    if (cache && now() < cache.expiresAt) return cache.value;
    inflight ??= load().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function list(access, { sede, cargo, q } = {}) {
    if (sede !== undefined && !canAccessSede(access, sede)) {
      throw createHttpError(403, "No tienes acceso a esta sede.", "FORBIDDEN_SEDE");
    }
    const { rows, actualizado } = await getDirectory();
    let data = filterForAccess(rows, access);
    if (sede !== undefined) data = data.filter((row) => row.sedeId === sede);
    if (cargo) {
      const needle = fold(cargo);
      data = data.filter((row) => fold(row.cargo).includes(needle));
    }
    if (q) {
      const needle = fold(q);
      const digits = /^[\d\s.,-]+$/.test(q) ? normalizeCedula(q) : "";
      data = data.filter(
        (row) => fold(row.nombre).includes(needle) || (digits !== "" && row.cedula.includes(digits)),
      );
    }
    return { data, total: data.length, actualizado };
  }

  return { list };
}
