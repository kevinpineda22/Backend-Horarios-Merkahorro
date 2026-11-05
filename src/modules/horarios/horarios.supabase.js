import { createHttpError } from "../../shared/http/HttpError.js";

const SCHEDULE_COLUMNS =
  "id, sede_id, week_start, state, version, published_by, published_at, created_by, created_at, updated_by, updated_at";
const SHIFT_COLUMNS =
  "id, schedule_id, sede_id, siesa_code, cedula, fecha, tipo, start_time, end_time, break_minutes, lunch_start, cargo, observacion, updated_by, updated_at";
const HISTORY_COLUMNS = "id, shift_id, cedula, fecha, action, schedule_version, actor, at, before, after";

function parseConflicts(details) {
  try {
    const parsed = JSON.parse(details);
    return Array.isArray(parsed) ? parsed : [];
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

    async listShifts(scheduleId) {
      const { data, error } = await client
        .from("shifts")
        .select(SHIFT_COLUMNS)
        .eq("schedule_id", scheduleId)
        .order("cedula", { ascending: true })
        .order("fecha", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },

    /** Shifts of the given cedulas in every sede within [from, to]; optionally skipping one schedule. */
    async listShiftsByCedulas({ cedulas, from, to, excludeScheduleId = null }) {
      if (!cedulas.length) return [];
      let q = client
        .from("shifts")
        .select(SHIFT_COLUMNS)
        .in("cedula", cedulas)
        .gte("fecha", from)
        .lte("fecha", to);
      if (excludeScheduleId) q = q.neq("schedule_id", excludeScheduleId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
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
