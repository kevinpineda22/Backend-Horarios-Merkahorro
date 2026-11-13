import { filterForAccess, mapEmpleados } from "./domain/empleados.js";
import { canAccessSede } from "../../shared/http/authorize.js";
import { HttpError, createHttpError } from "../../shared/http/HttpError.js";
import { normalizeCedula } from "../../shared/cedula.js";
import { normalizeSedeAlias as fold } from "../../shared/sedeAlias.js";
import { isCashierCargo } from "../sugerido/repositories/staff.port.js";

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
 * Cashier marks are NOT part of the cached directory: they change on a click, so every list() reads the active ones
 * (one query) and decorates the rows it returns with `excluidoDeCaja` + `exclusion` ("Solo surtidor", migration 011)
 * and `incluidoEnCaja` + `inclusion` ("Programar en caja" with another cargo, migration 012). A person has at most one
 * active mark. Without an exclusionsRepo nobody is marked.
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
          const mark = byCedula.get(row.cedula) ?? null;
          const exclusion = mark?.kind === "include" ? null : mark;
          const inclusion = mark?.kind === "include" ? mark : null;
          return Object.freeze({
            ...row,
            excluidoDeCaja: exclusion !== null,
            exclusion: Object.freeze(await toExclusionDto(exclusion, nameOf)),
            incluidoEnCaja: inclusion !== null,
            inclusion: Object.freeze(await toExclusionDto(inclusion, nameOf)),
          });
        }),
      ),
    );
    return { data, total: data.length, actualizado };
  }

  /**
   * Marks / unmarks an active employee as "solo surtidor" (not scheduled at the register). Admin anywhere; a planner
   * only for employees of their sedes. Idempotent: the same state again is a no-op that keeps the existing row.
   */
  async function setMark(access, user, cedulaInput, kind, on, motivo) {
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

    // "Programar en caja" is for other cargos: a cashier cargo is already scheduled (or marked Solo surtidor).
    if (on && kind === "include" && isCashierCargo(employee.cargo)) {
      throw createHttpError(409, "Esta persona ya tiene cargo de caja.", "CARGO_YA_ES_CAJA");
    }
    if (!on) {
      // Only this kind: unmarking "Programar en caja" never lifts a "Solo surtidor", and the other way round.
      await exclusionsRepo.revoke({ cedula, userId: user.id, kind });
      return null;
    }
    const existing = (await exclusionsRepo.listActive()).find((e) => e.cedula === cedula) ?? null;
    const existingKind = existing ? existing.kind ?? "exclude" : null;
    if (existingKind === kind) return existing;
    if (existing) {
      // The two marks replace each other (one active row per cedula): lift the other one first.
      await exclusionsRepo.revoke({ cedula, userId: user.id, kind: existingKind });
    }
    let row;
    try {
      row = await exclusionsRepo.create({ cedula, sedeId: employee.sedeId ?? null, motivo: motivo ?? null, userId: user.id, kind });
    } catch (err) {
      // Never leave the person with NO mark because the second step failed: put the lifted one back (best effort).
      if (existing) {
        await exclusionsRepo
          .create({ cedula, sedeId: existing.sedeId ?? null, motivo: existing.motivo ?? null, userId: existing.createdBy ?? user.id, kind: existingKind })
          .catch(() => {});
      }
      throw err;
    }
    // A concurrent change won the race (create returns the active row): say so instead of reporting the wrong mark.
    if ((row?.kind ?? "exclude") !== kind) {
      throw createHttpError(409, "Otra persona cambió esta marca al mismo tiempo. Actualiza la lista.", "MARK_CONFLICT");
    }
    return row;
  }

  /** "Solo surtidor": not scheduled at the register although SIESA says cashier. Replaces a "Programar en caja". */
  async function setExclusion(access, user, cedulaInput, { excluido, motivo }) {
    const row = await setMark(access, user, cedulaInput, "exclude", excluido, motivo);
    const cedula = normalizeCedula(cedulaInput);
    return row ? { cedula, excluidoDeCaja: true, exclusion: await toExclusionDto(row, nameResolver()) } : { cedula, excluidoDeCaja: false, exclusion: null };
  }

  /** "Programar en caja": scheduled at the register although the SIESA cargo is not a cashier one. Replaces a "Solo surtidor". */
  async function setInclusion(access, user, cedulaInput, { incluido, motivo }) {
    const row = await setMark(access, user, cedulaInput, "include", incluido, motivo);
    const cedula = normalizeCedula(cedulaInput);
    return row ? { cedula, incluidoEnCaja: true, inclusion: await toExclusionDto(row, nameResolver()) } : { cedula, incluidoEnCaja: false, inclusion: null };
  }

  /**
   * The ACTIVE directory row of a cedula, or null (unknown and inactive are indistinguishable: the directory only
   * holds active rows). No access scoping: only for the public schedule lookup, which exposes a minimal projection.
   */
  async function findActiveByCedula(cedulaInput) {
    const cedula = normalizeCedula(cedulaInput);
    const { rows } = await getDirectory();
    return rows.find((r) => r.cedula === cedula) ?? null;
  }

  return { list, setExclusion, setInclusion, findActiveByCedula };
}
