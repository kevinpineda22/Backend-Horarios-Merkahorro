import { createHttpError } from "../../shared/http/HttpError.js";

const SCHEDULE_COLUMNS =
  "id, sede_id, week_start, state, version, published_by, published_at, created_by, created_at, updated_by, updated_at";
const SHIFT_COLUMNS =
  "id, schedule_id, sede_id, siesa_code, cedula, fecha, tipo, start_time, end_time, break_minutes, lunch_start, cargo, observacion, updated_by, updated_at";
const HISTORY_COLUMNS = "id, shift_id, cedula, fecha, action, schedule_version, actor, at, before, after";

const PAGE_SIZE = 1000;

// PostgREST caps a response at max-rows (1000), silently truncating. Page with .range() until a short page.
// `build` must return a fresh, deterministically ordered query each call.
export async function fetchAll(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

// Postgres sends time columns as "HH:MM:SS"; the API speaks "HH:MM" everywhere else.
const toHHMM = (value) => (typeof value === "string" && /^\d{2}:\d{2}:\d{2}$/.test(value) ? value.slice(0, 5) : value);

function parseConflicts(details) {
  try {
    const parsed = JSON.parse(details);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((c) => {
      const out = { ...c };
      for (const key of ["otherStart", "otherEnd"]) if (key in out) out[key] = toHHMM(out[key]);
      return out;
    });
  } catch {
    return [];
  }
}

// 004_shifts.sql exception messages -> HTTP errors. Anything else is rethrown untouched.
function mapRpcError(error) {
  const message = String(error?.message ?? "");
  if (message.includes("VERSION_CONFLICT")) {
    const err = createHttpError(
      409,
      "Otra persona guardó cambios en este horario. Carga la versión guardada para continuar.",
      "VERSION_CONFLICT",
    );
    err.details = { currentVersion: Number.parseInt(error.details, 10) || 0 };
    return err;
  }
  if (message.includes("SHIFT_OVERLAP")) {
    const err = createHttpError(422, "Un turno se cruza con otro turno de la misma persona.", "SHIFT_OVERLAP");
    err.details = { conflicts: parseConflicts(error.details) };
    return err;
  }
  if (message.includes("NOT_PUBLISHED")) {
    return createHttpError(409, "Este horario no está publicado.", "NOT_PUBLISHED");
  }
  if (message.includes("PAYROLL_CUT_PAID")) {
    const err = createHttpError(409, "No puedes despublicar: esta semana ya está en un corte de nómina pagado.", "PAYROLL_CUT_PAID");
    err.details = { cut: { id: Number.parseInt(error.details, 10) || null } };
    return err;
  }
  if (message.includes("SCHEDULE_NOT_FOUND")) {
    return createHttpError(404, "Todavía no hay un horario guardado para esta semana.", "SCHEDULE_NOT_FOUND");
  }
  if (message.includes("INVALID_SHIFTS")) {
    return createHttpError(400, "Los turnos enviados no son válidos.", "INVALID_SHIFTS");
  }
  // Foreign-key fallback: the sede disappeared between the existence check and the write.
  if (error?.code === "23503") return createHttpError(404, "Sede no encontrada.", "SEDE_NOT_FOUND");
  return error;
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw mapRpcError(error);
  return data;
}

// camelCase API rows -> the snake_case keys jsonb_to_recordset reads in shifts_save_week.
const toRpcShift = (s) => ({
  cedula: s.cedula,
  fecha: s.fecha,
  tipo: s.tipo,
  start_time: s.startTime ?? null,
  end_time: s.endTime ?? null,
  break_minutes: s.breakMinutes ?? null,
  lunch_start: s.lunchStart ?? null,
  cargo: s.cargo ?? null,
  observacion: s.observacion ?? null,
});

/** Shift persistence over `sede_week_schedules` / `shifts` / `shift_history` and the 004 RPCs. */
export function createHorariosRepo(client) {
  return {
    async findSede(sedeId) {
      const { data, error } = await client
        .from("sugerido_sedes")
        .select("sede_id, siesa_code")
        .eq("sede_id", sedeId)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },

    async findSchedule(sedeId, weekStart) {
      const { data, error } = await client
        .from("sede_week_schedules")
        .select(SCHEDULE_COLUMNS)
        .eq("sede_id", sedeId)
        .eq("week_start", weekStart)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },

    /** Schedules of a sede in one state, newest week first. One query. */
    async listSchedules({ sedeId, status, limit }) {
      const { data, error } = await client
        .from("sede_week_schedules")
        .select(SCHEDULE_COLUMNS)
        .eq("sede_id", sedeId)
        .eq("state", status)
        .order("week_start", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },

    /** Distinct cedulas per schedule in ONE grouped rpc (migration 009): { [scheduleId]: n }. */
    async countPeople(scheduleIds) {
      if (!scheduleIds.length) return {};
      const { data, error } = await client.rpc("shifts_people_counts", { p_schedule_ids: scheduleIds });
      if (error) throw error;
      return Object.fromEntries((data ?? []).map((r) => [r.schedule_id, Number(r.people)]));
    },

    async listShifts(scheduleId) {
      return fetchAll(() =>
        client
          .from("shifts")
          .select(SHIFT_COLUMNS)
          .eq("schedule_id", scheduleId)
          .order("cedula", { ascending: true })
          .order("fecha", { ascending: true })
          .order("id", { ascending: true }),
      );
    },

    /** Shifts of the given cedulas in every sede within [from, to]; optionally skipping one schedule. */
    async listShiftsByCedulas({ cedulas, from, to, excludeScheduleId = null }) {
      if (!cedulas.length) return [];
      return fetchAll(() => {
        let q = client
          .from("shifts")
          .select(SHIFT_COLUMNS)
          .in("cedula", cedulas)
          .gte("fecha", from)
          .lte("fecha", to)
          .order("id", { ascending: true });
        if (excludeScheduleId) q = q.neq("schedule_id", excludeScheduleId);
        return q;
      });
    },

    saveWeek: ({ sedeId, weekStart, expectedVersion, cedulas, shifts, actor }) =>
      rpc(client, "shifts_save_week", {
        p_sede: sedeId,
        p_week: weekStart,
        p_expected_version: expectedVersion ?? 0,
        p_cedulas: cedulas,
        p_shifts: shifts.map(toRpcShift),
        p_actor: actor,
      }),

    publishWeek: ({ sedeId, weekStart, expectedVersion, actor }) =>
      rpc(client, "shifts_publish_week", {
        p_sede: sedeId,
        p_week: weekStart,
        p_expected_version: expectedVersion,
        p_actor: actor,
      }),

    unpublishWeek: ({ sedeId, weekStart, expectedVersion, actor }) =>
      rpc(client, "shifts_unpublish_week", {
        p_sede: sedeId,
        p_week: weekStart,
        p_expected_version: expectedVersion,
        p_actor: actor,
      }),

    /** A PAGADO payroll cut that shares at least one day with [from, to]: { id, from, to } or null. ANULADO cuts never match. */
    async findPaidCutOverlapping(from, to) {
      const { data, error } = await client
        .from("payroll_cuts")
        .select("id, period_start, period_end")
        .eq("state", "PAGADO")
        .lte("period_start", to)
        .gte("period_end", from)
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? { id: Number(data.id), from: data.period_start, to: data.period_end } : null;
    },

    async listHistory({ scheduleId, limit }) {
      const { data, error } = await client
        .from("shift_history")
        .select(HISTORY_COLUMNS)
        .eq("schedule_id", scheduleId)
        .order("at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
  };
}
