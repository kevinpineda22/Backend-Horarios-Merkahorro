import { createHttpError } from "../../shared/http/HttpError.js";

const TABLE = "novedades";
const FK_VIOLATION = "23503";

/** Throws the query error; a foreign-key violation can only come from `sede_id`. */
function unwrap({ data, error }) {
  if (!error) return data;
  if (error.code === FK_VIOLATION) throw createHttpError(404, "La sede indicada no existe.", "SEDE_NOT_FOUND");
  throw error;
}

/** Supabase implementation of the novedades repository port (client injected). */
export function createNovedadesRepo(client) {
  return {
    async list(f) {
      let q = client.from(TABLE).select("*");
      if (!f.incluirAnuladas) q = q.eq("anulada", false);
      if (f.sede) q = q.eq("sede_id", f.sede);
      if (f.sedeIds) q = q.in("sede_id", f.sedeIds);
      if (f.sedeNotNull) q = q.not("sede_id", "is", null);
      if (f.cedula) q = q.eq("cedula", f.cedula);
      if (f.tipo) q = q.eq("tipo", f.tipo);
      if (f.desde) q = q.gte("fecha_fin", f.desde);
      if (f.hasta) q = q.lte("fecha_inicio", f.hasta);
      return unwrap(await q.order("fecha_inicio", { ascending: false }).limit(f.limit));
    },

    async findById(id) {
      return unwrap(await client.from(TABLE).select("*").eq("id", id).maybeSingle());
    },

    async findOverlapping({ cedula, desde, hasta, excludeId }) {
      let q = client
        .from(TABLE)
        .select("id")
        .eq("cedula", cedula)
        .eq("anulada", false)
        .lte("fecha_inicio", hasta)
        .gte("fecha_fin", desde);
      if (excludeId) q = q.neq("id", excludeId);
      return unwrap(await q);
    },

    async insert(row) {
      return unwrap(await client.from(TABLE).insert(row).select().single());
    },

    /** Returns the updated row, or null when nothing matched (e.g. cancelled meanwhile). */
    async update(id, patch, { onlyActive = false } = {}) {
      let q = client.from(TABLE).update(patch).eq("id", id);
      if (onlyActive) q = q.eq("anulada", false);
      return unwrap(await q.select().maybeSingle());
    },
  };
}
