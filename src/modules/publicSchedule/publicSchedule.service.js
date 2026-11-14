import { createHttpError } from "../../shared/http/HttpError.js";
import { NOVEDAD_TYPES } from "../novedades/domain/novedadTypes.js";
import { getHoliday } from "../sugerido/domain/calendar.js";
import { addDays, bogotaToday, mondayOf } from "../sugerido/domain/dates.js";
import { spanMinutes } from "../horarios/domain/weekPayload.js";

export const WEEKS_BACK = 4;
export const WEEKS_AHEAD = 8;

const NOT_FOUND_MESSAGE = "No encontramos horarios para esa cédula.";
const notFound = () => createHttpError(404, NOT_FOUND_MESSAGE, "NOT_FOUND");

// Postgres sends time columns as "HH:MM:SS"; the API speaks "HH:MM".
const toHHMM = (value) => (typeof value === "string" ? value.slice(0, 5) : null);
const round2 = (n) => Math.round(n * 100) / 100;

// Incapacidades (general and ARL/work accident) and Licencias reveal health data: publicly they are one neutral label.
const JUSTIFIED_ABSENCE_LABEL = "Ausencia justificada";
const HEALTH_TIPOS = new Set(["Incapacidades", "Licencias"]);

function publicNovedadLabel(tipo) {
  if (HEALTH_TIPOS.has(tipo)) return JUSTIFIED_ABSENCE_LABEL;
  return NOVEDAD_TYPES.includes(tipo) ? tipo : "Novedad";
}

// Frozen caja/surtido split (migration 014) -> [{ rol, desde, hasta }]; null when the shift has none (older publications).
function toSegmentos(row) {
  if (row.tipo !== "TRABAJO" || !Array.isArray(row.segments) || row.segments.length === 0) return null;
  return row.segments.map((s) => ({ rol: s.role, desde: s.from, hasta: s.to }));
}

/** One shift row -> the minimal public day. Observacion, ids and audit columns never get here. */
function toDay(row) {
  const worked = row.tipo === "TRABAJO";
  const entrada = worked ? toHHMM(row.start_time) : null;
  const salida = worked ? toHHMM(row.end_time) : null;
  const breakMinutes = worked ? Number(row.break_minutes) || 0 : 0;
  const horas = worked ? round2(Math.max(0, spanMinutes(entrada, salida) - breakMinutes) / 60) : 0;
  return {
    fecha: row.fecha,
    tipo: row.tipo, // TRABAJO | DESCANSO | COMPENSATORIO
    entrada,
    salida,
    horas,
    descansoMinutos: breakMinutes,
    almuerzo: worked ? toHHMM(row.lunch_start) : null,
    segmentos: toSegmentos(row), // caja/surtido split frozen at publication, or null
    festivo: getHoliday(row.fecha), // holiday name or null; Sundays are derivable from `fecha`
  };
}

/**
 * Public "my schedule" lookup. Returns PUBLISHED weeks only, for one ACTIVE employee, as a minimal projection:
 * no cedula echo, no observations, no ids. Unknown and inactive employees are indistinguishable (same 404).
 * An active employee without published shifts in the window gets an empty `semanas` list.
 */
export function createPublicScheduleService({ empleadosService, horariosRepo, novedadesRepo, now = () => new Date() }) {
  async function consulta({ cedula }) {
    let employee;
    try {
      employee = await empleadosService.findActiveByCedula(cedula);
    } catch {
      // Hide the upstream failure detail (English message, internal codes) from the public.
      throw createHttpError(503, "El servicio no está disponible. Intenta de nuevo más tarde.", "SERVICE_UNAVAILABLE");
    }
    if (!employee) throw notFound();

    const currentMonday = mondayOf(bogotaToday(now()));
    const from = addDays(currentMonday, -WEEKS_BACK * 7);
    const lastMonday = addDays(currentMonday, WEEKS_AHEAD * 7);
    const windowEnd = addDays(lastMonday, 6);

    // 1) the employee's own shifts in the window (small), 2) only the published schedules among those ids.
    const candidateRows = await horariosRepo.listShiftsByCedulaInRange({ cedula, from, to: windowEnd });
    const candidateIds = [...new Set(candidateRows.map((r) => r.schedule_id))];
    const schedules = candidateIds.length ? await horariosRepo.listPublishedSchedulesByIds(candidateIds) : [];
    const weekOf = new Map(schedules.map((s) => [s.id, s.week_start]));
    const rows = candidateRows.filter((r) => weekOf.has(r.schedule_id));

    // Group by the schedule's Monday: the same week may hold rows from several sedes.
    const byWeek = new Map();
    for (const row of rows) {
      const weekStart = weekOf.get(row.schedule_id);
      if (!weekStart) continue; // defensive: rows are already filtered to published schedules
      if (!byWeek.has(weekStart)) byWeek.set(weekStart, []);
      byWeek.get(weekStart).push(toDay(row));
    }
    const semanas = [...byWeek.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([weekStart, dias]) => {
        dias.sort((a, b) => (a.fecha + (a.entrada ?? "")).localeCompare(b.fecha + (b.entrada ?? "")));
        return {
          weekStart,
          weekEnd: addDays(weekStart, 6),
          dias,
          totalHoras: round2(dias.reduce((sum, d) => sum + d.horas, 0)),
        };
      });

    // Only a label + dates leave the service. Health-related tipos are masked server-side so the raw type never leaves.
    const rawNovedades = semanas.length ? await novedadesRepo.listPublicByCedula({ cedula, desde: from, hasta: windowEnd }) : [];
    const novedades = rawNovedades.map((n) => ({
      tipo: publicNovedadLabel(n.tipo),
      fechaInicio: n.fecha_inicio,
      fechaFin: n.fecha_fin,
    }));

    return {
      data: {
        empleado: { nombre: employee.nombre, sede: employee.sedeNombre ?? null },
        semanas,
        novedades,
      },
    };
  }

  return { consulta };
}
