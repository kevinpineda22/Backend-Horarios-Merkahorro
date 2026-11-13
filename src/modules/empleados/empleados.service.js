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
 *
 * Cashier exclusions ("Solo surtidor", migration 011) are NOT part of the cached directory: they change on a click,
 * so every list() reads the active ones (one query) and decorates the rows it returns with `excluidoDeCaja` and
 * `exclusion`. Without an exclusionsRepo nobody is excluded.
 */
export function createEmpleadosService({
  client,
  aliasRepo,
  exclusionsRepo = null,
  profilesRepo = null,
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

  const toExclusionDto = async (e, nameOf) =>
    e ? { motivo: e.motivo ?? null, createdAt: e.createdAt ?? null, createdByName: await nameOf(e.createdBy) } : null;

  function nameResolver() {
    const cache = new Map();
    return (userId) => {
      if (!userId || !profilesRepo) return Promise.resolve(null);
      if (!cache.has(userId)) cache.set(userId, profilesRepo.findById(userId).then((p) => p?.nombre ?? null));
      return cache.get(userId);
    };
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
    const active = exclusionsRepo ? await exclusionsRepo.listActive() : [];
    const byCedula = new Map(active.map((e) => [e.cedula, e]));
    const nameOf = nameResolver();
    // Frozen like the cached rows: callers share these objects and must not be able to change them.
    data = Object.freeze(
      await Promise.all(
        data.map(async (row) => {
          const exclusion = byCedula.get(row.cedula) ?? null;
          return Object.freeze({ ...row, excluidoDeCaja: exclusion !== null, exclusion: Object.freeze(await toExclusionDto(exclusion, nameOf)) });
        }),
      ),
    );
    return { data, total: data.length, actualizado };
  }

  /**
   * Marks / unmarks an active employee as "solo surtidor" (not scheduled at the register). Admin anywhere; a planner
   * only for employees of their sedes. Idempotent: the same state again is a no-op that keeps the existing row.
   */
  async function setExclusion(access, user, cedulaInput, { excluido, motivo }) {
    if (!access || !["admin", "planner"].includes(access.role)) {
      throw createHttpError(403, "No tienes permisos para realizar esta acción.", "FORBIDDEN_ROLE");
    }
    const cedula = normalizeCedula(cedulaInput);
    const { rows } = await getDirectory();
    const employee = rows.find((r) => r.cedula === cedula);
    if (!employee) throw createHttpError(404, "Empleado no encontrado.", "EMPLEADO_NOT_FOUND");
    if (!canAccessSede(access, employee.sedeId)) {
      throw createHttpError(403, "No tienes acceso a esta sede.", "FORBIDDEN_SEDE");
    }

    const nameOf = nameResolver();
    if (!excluido) {
      await exclusionsRepo.revoke({ cedula, userId: user.id });
      return { cedula, excluidoDeCaja: false, exclusion: null };
    }
    const existing = (await exclusionsRepo.listActive()).find((e) => e.cedula === cedula);
    const row = existing ?? (await exclusionsRepo.create({ cedula, sedeId: employee.sedeId ?? null, motivo: motivo ?? null, userId: user.id }));
    return { cedula, excluidoDeCaja: true, exclusion: await toExclusionDto(row, nameOf) };
  }

  return { list, setExclusion };
}
