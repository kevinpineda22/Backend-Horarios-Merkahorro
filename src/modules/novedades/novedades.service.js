import { createHttpError } from "../../shared/http/HttpError.js";
import { canAccessSede } from "../../shared/http/authorize.js";
import { toNovedadDto } from "./domain/ranges.js";

/**
 * Novedades use cases. `repo` is the injected persistence port:
 *   list(filters) / findById(id) / findOverlapping({cedula, desde, hasta, excludeId})
 *   insert(row) / update(id, patch, { onlyActive }) -> row | null
 * Role checks live in the routes; sede scoping is enforced here as well (R-c: rows
 * without a sede are admin-only). Audit columns always come from the authenticated user.
 */

export const LIST_CAP = 500;

const forbiddenSede = () => createHttpError(403, "No tienes acceso a esta sede.", "FORBIDDEN_SEDE");
const notFound = () => createHttpError(404, "Novedad no encontrada.", "NOVEDAD_NOT_FOUND");
const cancelled = () =>
  createHttpError(409, "La novedad está anulada y no se puede modificar.", "NOVEDAD_CANCELLED");

function badRange() {
  const err = createHttpError(400, "Datos de entrada inválidos", "VALIDATION_ERROR");
  err.details = [{ path: "body.fechaFin", message: "fechaFin no puede ser anterior a fechaInicio" }];
  return err;
}

export function createNovedadesService({ repo, now = () => new Date() }) {
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

    async create(access, user, input) {
      if (!canAccessSede(access, input.sedeId)) throw forbiddenSede();
      const draft = {
        cedula: input.cedula,
        tipo: input.tipo,
        fecha_inicio: input.fechaInicio,
        fecha_fin: input.fechaFin,
        observacion: input.observacion ?? null,
        sede_id: input.sedeId ?? null,
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
