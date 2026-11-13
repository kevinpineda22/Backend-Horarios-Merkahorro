import { createHttpError } from "../../shared/http/HttpError.js";
import { fetchAll } from "./horarios.supabase.js";

const SHIFT_COLUMNS =
  "id, sede_id, siesa_code, cedula, fecha, tipo, start_time, end_time, break_minutes, lunch_start, cargo";

const CUT_COLUMNS =
  "id, period_start, period_end, state, employees, extras, nocturnas, dominicales, festivos, sundays, holidays, engine_version, created_by, created_at, voided_by, voided_at, void_reason";
const LINE_COLUMNS =
  "cut_id, cedula, nombre, cargo, sede_id, siesa_code, branch_source, in_directory, worked_hours, extras, nocturnas, dominicales, festivos, sunday_festive_hours";
const WEEK_COLUMNS =
  "cut_id, cedula, week_start, worked_hours, extras, nocturnas, dominicales, festivos, sunday_festive_hours, has_overlap";
const SUM_KEYS = ["extras", "nocturnas", "dominicales", "festivos"];

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const toCutRef = (row) => (row ? { id: Number(row.id), from: row.period_start, to: row.period_end } : null);

// 005_payroll_cuts.sql exception messages -> HTTP errors. Anything else is rethrown untouched.
function mapRpcError(error) {
  const message = String(error?.message ?? "");
  if (message.includes("PAYROLL_CUT_OVERLAP") || error?.code === "23P01") {
    const err = createHttpError(409, "Ya existe un corte pagado que se cruza con este periodo.", "PAYROLL_CUT_OVERLAP");
    err.details = { cut: parseJson(error.details) };
    return err;
  }
  if (message.includes("PAYROLL_CUT_NOT_FOUND")) {
    return createHttpError(404, "Corte no encontrado.", "PAYROLL_CUT_NOT_FOUND");
  }
  if (message.includes("PAYROLL_CUT_ALREADY_VOID")) {
    return createHttpError(409, "Este corte ya está anulado.", "PAYROLL_CUT_ALREADY_VOID");
  }
  // 23514: a table check rejected a value of the snapshot after the RPC's own validation.
  if (message.includes("INVALID_SNAPSHOT") || error?.code === "23514") {
    return createHttpError(400, "Los datos del corte no son válidos.", "INVALID_SNAPSHOT");
  }
  return error;
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw mapRpcError(error);
  return data;
}

/**
 * Queries of the payroll report over `shifts`, `sede_week_schedules` and `sugerido_sedes`, plus the
 * payroll cuts (005): reads over `payroll_cuts` / `payroll_cut_lines` / `payroll_cut_weeks` and the two RPCs.
 */
export function createPayrollRepo(client) {
  return {
    /**
     * Every shift of every sede and tipo with fecha in [from, to] whose schedule is PUBLICADO; paged so nothing
     * is truncated. The filter is an inner embed over the (schedule_id, sede_id) FK, so BORRADOR shifts never
     * reach payroll. The embed is stripped from the rows: callers get plain shift rows.
     */
    async listShiftsInRange({ from, to }) {
      const rows = await fetchAll(() =>
        client
          .from("shifts")
          .select(`${SHIFT_COLUMNS}, sede_week_schedules!inner(state)`)
          .eq("sede_week_schedules.state", "PUBLICADO")
          .gte("fecha", from)
          .lte("fecha", to)
          .order("id", { ascending: true }),
      );
      return rows.map(({ sede_week_schedules: _schedule, ...shift }) => shift);
    },

    /**
     * TRABAJO shifts with fecha in [from, to] that belong to a BORRADOR schedule: only { sede_id, fecha }.
     * Drafts are excluded from the report, so this tells which sede-weeks were left out.
     */
    listDraftWorkShifts({ from, to }) {
      return fetchAll(() =>
        client
          .from("shifts")
          .select("sede_id, fecha, sede_week_schedules!inner(state)")
          .eq("sede_week_schedules.state", "BORRADOR")
          .eq("tipo", "TRABAJO")
          .gte("fecha", from)
          .lte("fecha", to)
          .order("id", { ascending: true }),
      );
    },

    /** Schedule state of every sede for the weeks whose Monday is in [fromWeek, toWeek]. */
    listSchedulesInRange({ fromWeek, toWeek }) {
      return fetchAll(() =>
        client
          .from("sede_week_schedules")
          .select("sede_id, week_start, state")
          .gte("week_start", fromWeek)
          .lte("week_start", toWeek)
          .order("sede_id", { ascending: true })
          .order("week_start", { ascending: true }),
      );
    },

    /** Sede catalog: SIESA branch code and whether the sede is active. */
    listSedes() {
      return fetchAll(() =>
        client.from("sugerido_sedes").select("sede_id, siesa_code, activo").order("sede_id", { ascending: true }),
      );
    },

    /** payroll_cut_save: recomputed snapshot in, the stored `payroll_cuts` row out (snake_case). */
    saveCut: ({ from, to, snapshot, actor }) =>
      rpc(client, "payroll_cut_save", { p_from: from, p_to: to, p_snapshot: snapshot, p_actor: actor }),

    /** payroll_cut_void: PAGADO -> ANULADO. The reason is optional. */
    voidCut: ({ id, reason = null, actor }) =>
      rpc(client, "payroll_cut_void", { p_id: id, p_reason: reason ?? null, p_actor: actor }),

    /** Cut history, ANULADO included, newest period first (period_end, period_start, id desc). */
    async listCuts({ limit }) {
      const { data, error } = await client
        .from("payroll_cuts")
        .select(CUT_COLUMNS)
        .order("period_end", { ascending: false })
        .order("period_start", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },

    /** One cut with its frozen lines and weeks, or null. Children are paged so nothing is truncated. */
    async getCut(id) {
      const { data: cut, error } = await client.from("payroll_cuts").select(CUT_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw error;
      if (!cut) return null;
      const [lines, weeks] = await Promise.all([
        fetchAll(() =>
          client.from("payroll_cut_lines").select(LINE_COLUMNS).eq("cut_id", id).order("cedula", { ascending: true }),
        ),
        fetchAll(() =>
          client
            .from("payroll_cut_weeks")
            .select(WEEK_COLUMNS)
            .eq("cut_id", id)
            .order("cedula", { ascending: true })
            .order("week_start", { ascending: true }),
        ),
      ]);
      return { cut, lines, weeks };
    },

    /** A PAGADO cut that shares at least one day with [from, to]: { id, from, to } or null. */
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
      return toCutRef(data);
    },

    /** The PAGADO cut with the latest end: { id, from, to } or null. Drives the default period (W2). */
    async findLastPaidCut() {
      const { data, error } = await client
        .from("payroll_cuts")
        .select("id, period_start, period_end")
        .eq("state", "PAGADO")
        .order("period_end", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return toCutRef(data);
    },

    /** Totals of the lines of `sedeIds` per cut id: Map<cutId, { employees, extras, nocturnas, dominicales, festivos }>. */
    async sumCutLines({ cutIds, sedeIds }) {
      const out = new Map();
      if (!cutIds.length || !sedeIds.length) return out;
      const lines = await fetchAll(() =>
        client
          .from("payroll_cut_lines")
          .select("cut_id, cedula, extras, nocturnas, dominicales, festivos")
          .in("cut_id", cutIds)
          .in("sede_id", sedeIds)
          .order("cut_id", { ascending: true })
          .order("cedula", { ascending: true }),
      );
      for (const line of lines) {
        const acc = out.get(line.cut_id) ?? { employees: 0, extras: 0, nocturnas: 0, dominicales: 0, festivos: 0 };
        acc.employees += 1;
        for (const k of SUM_KEYS) acc[k] = Math.round((acc[k] + Number(line[k] || 0)) * 100) / 100;
        out.set(line.cut_id, acc);
      }
      return out;
    },
  };
}
