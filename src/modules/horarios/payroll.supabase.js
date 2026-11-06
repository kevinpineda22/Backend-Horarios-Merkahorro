import { fetchAll } from "./horarios.supabase.js";

const SHIFT_COLUMNS =
  "id, sede_id, siesa_code, cedula, fecha, tipo, start_time, end_time, break_minutes, lunch_start, cargo";

/**
 * Read-only queries of the payroll report over `shifts`, `sede_week_schedules` and `sugerido_sedes`.
 * Slice 2 adds the cut methods (saveCut, findPaidCutOverlapping, ...) here.
 */
export function createPayrollRepo(client) {
  return {
    /** Every shift of every sede and tipo with fecha in [from, to]; paged so nothing is truncated. */
    listShiftsInRange({ from, to }) {
      return fetchAll(() =>
        client
          .from("shifts")
          .select(SHIFT_COLUMNS)
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
  };
}
