import { createHttpError } from "../../shared/http/HttpError.js";

const SCHEDULE_COLUMNS =
  "id, sede_id, week_start, state, version, published_by, published_at, created_by, created_at, updated_by, updated_at";
const SHIFT_COLUMNS =
  "id, schedule_id, sede_id, siesa_code, cedula, fecha, tipo, start_time, end_time, break_minutes, lunch_start, cargo, observacion, updated_by, updated_at";
// Public lookup: deliberately short (no observacion, cargo, audit or id columns).
const PUBLIC_SHIFT_COLUMNS = "schedule_id, fecha, tipo, start_time, end_time, break_minutes, lunch_start";
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

// Migration 014 not applied yet: PostgREST cannot find the 5/7-argument functions (PGRST202; 42883 straight from Postgres).
const isMissingFunction = (error) => error?.code === "PGRST202" || error?.code === "42883";
// ... or the segments column is missing (42703 from Postgres, PGRST204 when PostgREST's schema cache does not know it).
const isMissingColumn = (error) => error?.code === "42703" || error?.code === "PGRST204";

/**
 * Calls the migration-014 RPC (it also stores the segments). When it does not exist yet, falls back to the previous
 * function without segments so publishing and saving keep working. Resolves { data, segmentsSaved }.
 */
async function rpcWithSegments(client, { name, args, segments, logger }) {
  if (!segments) return { data: await rpc(client, name, args), segmentsSaved: false };
  const first = await client.rpc(name, { ...args, p_segments: segments });
  if (!first.error) return { data: first.data, segmentsSaved: true };
  if (!isMissingFunction(first.error)) throw mapRpcError(first.error);
  logger?.warn?.(`[horarios] ${name} with segments is missing (apply migration 014); falling back without segments`);
  return { data: await rpc(client, name, args), segmentsSaved: false };
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
export function createHorariosRepo(client, { logger = console } = {}) {
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

    /**
     * Shifts of ONE cedula whose date is within [from, to], across every sede and state. Public lookup step 1:
     * the result is small (one employee, ~13 weeks) and yields the schedule ids to check for publication.
     * The column list is deliberately short (no observacion, cargo, audit or id columns); `segments` is the frozen
     * caja/surtido split (migration 014) and is simply left out until that migration is applied.
     */
    async listShiftsByCedulaInRange({ cedula, from, to }) {
      const query = (columns) =>
        fetchAll(() =>
          client
            .from("shifts")
            .select(columns)
            .eq("cedula", cedula)
            .gte("fecha", from)
            .lte("fecha", to)
            .order("fecha", { ascending: true })
            .order("id", { ascending: true }),
        );
      try {
        return await query(`${PUBLIC_SHIFT_COLUMNS}, segments`);
      } catch (error) {
        if (!isMissingColumn(error)) throw error;
        logger?.warn?.("[horarios] shifts.segments is missing (apply migration 014); answering without segments");
        return query(PUBLIC_SHIFT_COLUMNS);
      }
    },

    /**
     * Public lookup step 2: of the given schedule ids, only the PUBLICADO ones: [{ id, week_start }].
     * The published-only filter runs in the database. The id list is tiny (distinct weeks of one employee),
     * so it never approaches the PostgREST URL length limit.
     */
    async listPublishedSchedulesByIds(scheduleIds) {
      if (!scheduleIds.length) return [];
      const { data, error } = await client
        .from("sede_week_schedules")
        .select("id, week_start")
        .eq("state", "PUBLICADO")
        .in("id", scheduleIds);
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

    /** Resolves the week row; `segments` (optional [{ cedula, fecha, segments }]) goes in the same transaction (014). */
    async saveWeek({ sedeId, weekStart, expectedVersion, cedulas, shifts, actor, segments = null }) {
      const { data, segmentsSaved } = await rpcWithSegments(client, {
        name: "shifts_save_week",
        args: {
          p_sede: sedeId,
          p_week: weekStart,
          p_expected_version: expectedVersion ?? 0,
          p_cedulas: cedulas,
          p_shifts: shifts.map(toRpcShift),
          p_actor: actor,
        },
        segments,
        logger,
      });
      return segmentsSaved ? { ...data, segmentsSaved } : data;
    },

    /** Like saveWeek: with `segments` the migration-014 RPC freezes them atomically; `segmentsSaved` tells which ran. */
    async publishWeek({ sedeId, weekStart, expectedVersion, actor, segments = null }) {
      const { data, segmentsSaved } = await rpcWithSegments(client, {
        name: "shifts_publish_week",
        args: { p_sede: sedeId, p_week: weekStart, p_expected_version: expectedVersion, p_actor: actor },
        segments,
        logger,
      });
      return { ...(data ?? {}), segmentsSaved };
    },

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
