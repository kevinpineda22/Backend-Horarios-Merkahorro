import { createHttpError } from "../../shared/http/HttpError.js";

const TABLE = "overtime_requests";
const COLUMNS = "id, sede_id, week_start, hours, motivo, status, requested_by, requested_at, decided_by, decided_at, decision_comment";
const UNIQUE_VIOLATION = "23505";

const iso = (value) => (value ? new Date(value).toISOString() : null);
const toRow = (r) => ({
  id: r.id,
  sedeId: r.sede_id,
  weekStart: r.week_start,
  hours: Number(r.hours),
  motivo: r.motivo,
  status: r.status,
  requestedBy: r.requested_by,
  requestedAt: iso(r.requested_at),
  decidedBy: r.decided_by ?? null,
  decidedAt: iso(r.decided_at),
  decisionComment: r.decision_comment ?? null,
});

/** Overtime requests over `overtime_requests` (migration 014), plus the sede name for the e-mails. */
export function createOvertimeRepo(client) {
  const many = async (query) => {
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map(toRow);
  };
  const one = async (query) => {
    const { data, error } = await query;
    if (error) throw error;
    return data ? toRow(data) : null;
  };

  return {
    async findSede(sedeId) {
      const { data, error } = await client.from("sugerido_sedes").select("sede_id, nombre").eq("sede_id", sedeId).maybeSingle();
      if (error) throw error;
      return data ? { sedeId: data.sede_id, nombre: data.nombre ?? data.sede_id } : null;
    },

    findPending: (sedeId, weekStart) =>
      one(client.from(TABLE).select(COLUMNS).eq("sede_id", sedeId).eq("week_start", weekStart).eq("status", "PENDIENTE").maybeSingle()),

    /** A concurrent second pending request for the same week loses on the unique index: 409, never a duplicate. */
    async create({ sedeId, weekStart, hours, motivo, requestedBy }) {
      const { data, error } = await client
        .from(TABLE)
        .insert({ sede_id: sedeId, week_start: weekStart, hours, motivo, requested_by: requestedBy })
        .select(COLUMNS)
        .single();
      if (error?.code === UNIQUE_VIOLATION) {
        throw createHttpError(409, "Ya hay una solicitud de horas extra pendiente para esta semana.", "OVERTIME_REQUEST_PENDING");
      }
      if (error) throw error;
      return toRow(data);
    },

    listByWeek: (sedeId, weekStart) => many(client.from(TABLE).select(COLUMNS).eq("sede_id", sedeId).eq("week_start", weekStart).order("requested_at", { ascending: false })),

    listByStatus({ status, limit = 100 }) {
      let query = client.from(TABLE).select(COLUMNS);
      if (status) query = query.eq("status", status);
      return many(query.order("requested_at", { ascending: false }).limit(limit));
    },

    findById: (id) => one(client.from(TABLE).select(COLUMNS).eq("id", id).maybeSingle()),

    /** Decides only a PENDIENTE row; null when another approver got there first. */
    async decide({ id, status, decidedBy, comment }) {
      const { data, error } = await client
        .from(TABLE)
        .update({ status, decided_by: decidedBy, decided_at: new Date().toISOString(), decision_comment: comment ?? null })
        .eq("id", id)
        .eq("status", "PENDIENTE")
        .select(COLUMNS);
      if (error) throw error;
      return data?.[0] ? toRow(data[0]) : null;
    },
  };
}
