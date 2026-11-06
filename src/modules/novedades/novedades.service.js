import { createHttpError } from "../../shared/http/HttpError.js";
import { canAccessSede } from "../../shared/http/authorize.js";
import { randomUUID } from "node:crypto";
import { toNovedadDto } from "./domain/ranges.js";
import { SUBTIPO_ARL, validateNovedadRules } from "./domain/novedadTypes.js";
import { DOWNLOAD_URL_TTL_SECONDS, buildObjectPath } from "./domain/novedadFiles.js";

/**
 * Novedades use cases. `repo` is the injected persistence port:
 *   list(filters) / findById(id) / findOverlapping({cedula, desde, hasta, excludeId})
 *   insert(row) / update(id, patch, { onlyActive }) -> row | null
 * `storage` (private bucket) is only needed for ARL support files:
 *   createUploadUrl(path) / exists(path) / createDownloadUrl(path, seconds)
 * `profilesRepo.findById(userId) -> { nombre }` names the responsible leader (server-side only).
 * Role checks live in the routes; sede scoping is enforced here as well (R-c: rows
 * without a sede are admin-only). Audit columns always come from the authenticated user.
 */

export const LIST_CAP = 500;

const forbiddenSede = () => createHttpError(403, "No tienes acceso a esta sede.", "FORBIDDEN_SEDE");
const notFound = () => createHttpError(404, "Novedad no encontrada.", "NOVEDAD_NOT_FOUND");
const cancelled = () =>
  createHttpError(409, "La novedad está anulada y no se puede modificar.", "NOVEDAD_CANCELLED");

const fileNotFound = () =>
  createHttpError(404, "La novedad no tiene ese archivo.", "NOVEDAD_FILE_NOT_FOUND");
const storageUnavailable = () =>
  createHttpError(503, "El almacenamiento de archivos no está disponible.", "STORAGE_UNAVAILABLE");

function validationError(details) {
  const err = createHttpError(400, "Datos de entrada inválidos", "VALIDATION_ERROR");
  err.details = details.map(({ path, message }) => ({ path: `body.${path}`, message }));
  return err;
}

function badRange() {
  return validationError([{ path: "fechaFin", message: "fechaFin no puede ser anterior a fechaInicio" }]);
}

const FILE_LABEL = { adjuntoPath: "El soporte adjunto", firmaPath: "La firma" };
const FILE_COLUMN = { adjunto: "adjunto_path", firma: "firma_path", historia: "historia_path", soporte: "soporte_path" };
const RULE_FIELDS = ["tipo", "subtipo", "adjuntoPath", "firmaPath"];

export function createNovedadesService({
  repo,
  storage,
  profilesRepo,
  now = () => new Date(),
  newId = randomUUID,
}) {
  function requireStorage() {
    if (!storage) throw storageUnavailable();
    return storage;
  }

  /** 400 on the right field when an uploaded object is missing from the bucket. */
  async function assertFilesExist(files) {
    const entries = Object.entries(files).filter(([, path]) => path);
    if (entries.length === 0) return;
    const bucket = requireStorage();
    const missing = [];
    for (const [field, path] of entries) {
      if (!(await bucket.exists(path))) {
        missing.push({ path: field, message: `${FILE_LABEL[field]} no se encontró; súbelo de nuevo.` });
      }
    }
    if (missing.length) throw validationError(missing);
  }

  /** The leader who registers the novedad: id from the session, name from profiles (never the client). */
  async function responsableOf(user) {
    const profile = profilesRepo ? await profilesRepo.findById(user.id) : null;
    return { responsable_id: user.id, responsable_nombre: profile?.nombre ?? user.email ?? null };
  }

  /**
   * Subtipo / files / responsable columns for a patch. The ARL rules run on the MERGED state, and only
   * when the patch touches them, so legacy rows (Incapacidades without subtipo) stay editable.
   * Leaving ARL clears its files and responsable; entering ARL or replacing the signature makes the
   * caller the responsable.
   */
  async function subtypeChanges(user, current, patch) {
    if (!RULE_FIELDS.some((k) => k in patch)) return {};
    const before = {
      tipo: current.tipo,
      subtipo: current.subtipo ?? null,
      adjuntoPath: current.adjunto_path ?? null,
      firmaPath: current.firma_path ?? null,
    };
    const after = { ...before };
    for (const k of RULE_FIELDS) if (k in patch) after[k] = patch[k];
    if (before.subtipo === SUBTIPO_ARL && after.subtipo !== SUBTIPO_ARL) {
      if (!("adjuntoPath" in patch)) after.adjuntoPath = null;
      if (!("firmaPath" in patch)) after.firmaPath = null;
    }

    const issues = validateNovedadRules(after);
    if (issues.length) throw validationError(issues);

    const adjuntoChanged = after.adjuntoPath !== before.adjuntoPath;
    const firmaChanged = after.firmaPath !== before.firmaPath;
    await assertFilesExist({
      adjuntoPath: adjuntoChanged ? after.adjuntoPath : null,
      firmaPath: firmaChanged ? after.firmaPath : null,
    });

    const changes = {};
    if ("tipo" in patch) changes.tipo = after.tipo;
    if (after.subtipo !== before.subtipo) changes.subtipo = after.subtipo;
    if (adjuntoChanged) changes.adjunto_path = after.adjuntoPath;
    if (firmaChanged) changes.firma_path = after.firmaPath;
    if (after.subtipo === SUBTIPO_ARL) {
      if (before.subtipo !== SUBTIPO_ARL || firmaChanged) Object.assign(changes, await responsableOf(user));
    } else if (before.subtipo === SUBTIPO_ARL) {
      changes.responsable_id = null;
      changes.responsable_nombre = null;
    }
    return changes;
  }

  async function overlapWarnings(row, excludeId) {
    const hits = await repo.findOverlapping({
      cedula: row.cedula,
      desde: row.fecha_inicio,
      hasta: row.fecha_fin,
      excludeId,
    });
    return hits.length ? [{ code: "OVERLAP", ids: hits.map((h) => h.id) }] : [];
  }

  async function loadWritable(access, id) {
    const row = await repo.findById(id);
    if (!row) throw notFound();
    if (!canAccessSede(access, row.sede_id)) throw forbiddenSede();
    if (row.anulada) throw cancelled();
    return row;
  }

  return {
    async list(access, query) {
      if (query.sede && !canAccessSede(access, query.sede)) throw forbiddenSede();
      const admin = access.role === "admin";
      const rows = await repo.list({
        sede: query.sede,
        sedeIds: admin ? null : access.sedeIds,
        sedeNotNull: !admin,
        cedula: query.cedula,
        desde: query.desde,
        hasta: query.hasta,
        tipo: query.tipo,
        incluirAnuladas: query.incluirAnuladas === true,
        limit: LIST_CAP + 1,
      });
      return {
        data: rows.slice(0, LIST_CAP).map(toNovedadDto),
        truncated: rows.length > LIST_CAP,
        warnings: [],
      };
    },

    async get(access, id) {
      const row = await repo.findById(id);
      if (!row) throw notFound();
      if (!canAccessSede(access, row.sede_id)) throw forbiddenSede();
      return { data: toNovedadDto(row), warnings: [] };
    },

    async createUpload(access, { kind, contentType, sedeId }) {
      if (!canAccessSede(access, sedeId ?? null)) throw forbiddenSede();
      const bucket = requireStorage();
      // The path is built here from trusted parts only; the client file name is never used.
      const path = buildObjectPath({ kind, contentType, now: now(), id: newId() });
      const { signedUrl, token } = await bucket.createUploadUrl(path);
      return { path, signedUploadUrl: signedUrl, token };
    },

    async getFileUrl(access, id, kind) {
      const row = await repo.findById(id);
      if (!row) throw notFound();
      if (!canAccessSede(access, row.sede_id)) throw forbiddenSede();
      const path = row[FILE_COLUMN[kind]];
      if (!path) throw fileNotFound();
      const url = await requireStorage().createDownloadUrl(path, DOWNLOAD_URL_TTL_SECONDS);
      return { url };
    },

    async create(access, user, input) {
      if (!canAccessSede(access, input.sedeId)) throw forbiddenSede();
      const state = {
        tipo: input.tipo,
        subtipo: input.subtipo ?? null,
        adjuntoPath: input.adjuntoPath ?? null,
        firmaPath: input.firmaPath ?? null,
      };
      const issues = validateNovedadRules(state);
      if (issues.length) throw validationError(issues);
      await assertFilesExist({ adjuntoPath: state.adjuntoPath, firmaPath: state.firmaPath });

      const draft = {
        cedula: input.cedula,
        tipo: input.tipo,
        subtipo: state.subtipo,
        fecha_inicio: input.fechaInicio,
        fecha_fin: input.fechaFin,
        observacion: input.observacion ?? null,
        sede_id: input.sedeId ?? null,
        sede_nombre: input.sedeNombre ?? null,
        adjunto_path: state.adjuntoPath,
        firma_path: state.firmaPath,
        responsable_id: null,
        responsable_nombre: null,
        ...(state.subtipo === SUBTIPO_ARL ? await responsableOf(user) : {}),
        created_by: user.id,
        updated_by: user.id,
      };
      const warnings = await overlapWarnings(draft);
      const created = await repo.insert(draft);
      return { data: toNovedadDto(created), warnings };
    },

    async update(access, user, id, patch) {
      const current = await loadWritable(access, id);
      if ("sedeId" in patch && !canAccessSede(access, patch.sedeId)) throw forbiddenSede();

      const changes = {};
      if ("cedula" in patch) changes.cedula = patch.cedula;
      if ("tipo" in patch) changes.tipo = patch.tipo;
      if ("fechaInicio" in patch) changes.fecha_inicio = patch.fechaInicio;
      if ("fechaFin" in patch) changes.fecha_fin = patch.fechaFin;
      if ("observacion" in patch) changes.observacion = patch.observacion;
      if ("sedeId" in patch) changes.sede_id = patch.sedeId;
      if ("sedeNombre" in patch) changes.sede_nombre = patch.sedeNombre;
      Object.assign(changes, await subtypeChanges(user, current, patch));

      const merged = { ...current, ...changes };
      if (merged.fecha_fin < merged.fecha_inicio) throw badRange();

      const updated = await repo.update(
        id,
        { ...changes, updated_by: user.id, updated_at: now().toISOString() },
        { onlyActive: true },
      );
      if (!updated) throw cancelled();
      return { data: toNovedadDto(updated), warnings: await overlapWarnings(merged, id) };
    },

    async anular(access, user, id, { motivo }) {
      await loadWritable(access, id);
      const at = now().toISOString();
      const updated = await repo.update(
        id,
        {
          anulada: true,
          anulada_por: user.id,
          anulada_at: at,
          motivo_anulacion: motivo,
          updated_by: user.id,
          updated_at: at,
        },
        { onlyActive: true },
      );
      if (!updated) throw cancelled();
      return { data: toNovedadDto(updated), warnings: [] };
    },
  };
}
