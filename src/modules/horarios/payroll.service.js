import { createHash } from "node:crypto";
import { createHttpError } from "../../shared/http/HttpError.js";
import { canAccessSede } from "../../shared/http/authorize.js";
import { getHoliday } from "../sugerido/domain/calendar.js";
import { addDays, bogotaToday, diffDays, isoDow, mondayOf } from "../sugerido/domain/dates.js";
import { defaultPeriod, periodError, periodWeeks } from "./domain/payrollPeriod.js";
import {
  PAYROLL_ENGINE_VERSION,
  SIESA_HEADERS,
  employeeNovelties,
  roundHours,
  siesaTuples,
} from "./domain/payrollRules.js";

const READER_ROLES = ["admin", "planner"];
const ADMIN_SCOPE = Object.freeze({ role: "admin", sedeIds: null });
const CONCEPTS = ["extras", "nocturnas", "dominicales", "festivos"];

const hhmm = (t) => (t == null ? null : String(t).slice(0, 5));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The shape payrollRules works with: a shift row of any sede.
const toRuleRow = (r) => ({
  cedula: r.cedula,
  sedeId: r.sede_id,
  fecha: r.fecha,
  tipo: r.tipo,
  startTime: hhmm(r.start_time),
  endTime: hhmm(r.end_time),
  breakMinutes: r.break_minutes ?? 0,
  lunchStart: hhmm(r.lunch_start),
});

/** Holidays of [from, to] from the injected calendar: { set, list: [{ fecha, nombre }] }. */
export function buildHolidaySet(from, to, getHolidayFn = getHoliday) {
  const list = [];
  for (let d = from; diffDays(to, d) >= 0; d = addDays(d, 1)) {
    const nombre = getHolidayFn(d);
    if (nombre) list.push({ fecha: d, nombre });
  }
  return { set: new Set(list.map((h) => h.fecha)), list };
}

// Latest TRABAJO shift of the period: fecha desc, start desc, sede asc (W5).
const compareLast = (a, b) =>
  byText(b.fecha, a.fecha) || byText(String(b.start_time), String(a.start_time)) || byText(a.sede_id, b.sede_id);

const hasConcepts = (totals) => CONCEPTS.some((k) => totals[k] > 0);

// W3: hashes only hour-bearing data, so renames and zero-hour directory rows do not change it.
function fingerprintOf(allRows, holidayList) {
  const lines = allRows
    .filter((r) => r.totals.workedHours > 0)
    .sort((a, b) => byText(a.cedula, b.cedula))
    .map((r) => [
      r.cedula,
      r.siesaCode,
      r.weeks.map((w) => [w.weekStart, w.workedHours, w.extras, w.nocturnas, w.dominicales, w.festivos, w.sundayFestiveHours]),
    ]);
  const canonical = JSON.stringify({ v: PAYROLL_ENGINE_VERSION, holidays: holidayList.map((h) => h.fecha), lines });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Payroll report use cases. Ports:
 *   repo              listShiftsInRange / listSchedulesInRange / listSedes
 *                     (slice 2 adds findPaidCutOverlapping; optional until then)
 *   empleadosService  list(access) -> { data: [{ cedula, nombre, cargo, sedeId }] }
 *   getHolidayFn      (fecha) -> holiday name | null
 *   now               () -> Date (clock, injected for tests)
 * Every employee is computed company-wide (hours count across sedes); rows are filtered by access afterwards.
 */
export function createPayrollService({ repo, empleadosService, getHolidayFn = getHoliday, now = () => new Date() }) {
  function assertCanRead(access, sedeId) {
    if (!access || !READER_ROLES.includes(access.role)) {
      throw createHttpError(403, "No tienes permisos para realizar esta acción.", "FORBIDDEN_ROLE");
    }
    if (sedeId !== undefined && !canAccessSede(access, sedeId)) {
      throw createHttpError(403, "No tienes acceso a esta sede.", "FORBIDDEN_SEDE");
    }
  }

  function resolvePeriod({ from, to }, today) {
    if (from === undefined && to === undefined) {
      // Slice 2 seam: pass `lastPaidEnd` (end of the newest PAGADO cut) here, see payrollPeriod.defaultPeriod.
      return { ...defaultPeriod({ today, lastPaidEnd: null }), isDefault: true };
    }
    if (periodError(from, to)) {
      throw createHttpError(
        400,
        "El corte debe ser de 1 o 2 semanas completas, de lunes a domingo.",
        "PAYROLL_PERIOD_INVALID",
      );
    }
    return { from, to, isDefault: false };
  }

  async function loadDirectory() {
    try {
      const { data } = await empleadosService.list(ADMIN_SCOPE);
      return { byCedula: new Map(data.map((e) => [e.cedula, e])), available: true };
    } catch {
      return { byCedula: new Map(), available: false };
    }
  }

  return {
    async report(access, query = {}) {
      assertCanRead(access, query.sedeId);
      const today = bogotaToday(now());
      const { from, to, isDefault } = resolvePeriod(query, today);
      const weeks = periodWeeks(from, to);
      const { sedeId } = query;

      const [shiftRows, schedules, sedes, directory, paidCut] = await Promise.all([
        repo.listShiftsInRange({ from: addDays(from, -1), to }),
        repo.listSchedulesInRange({ fromWeek: from, toWeek: weeks[weeks.length - 1].weekStart }),
        repo.listSedes(),
        loadDirectory(),
        repo.findPaidCutOverlapping ? repo.findPaidCutOverlapping(from, to) : null,
      ]);

      const holidays = buildHolidaySet(from, to, getHolidayFn);
      const sundays = [];
      for (let d = from; diffDays(to, d) >= 0; d = addDays(d, 1)) if (isoDow(d) === 7) sundays.push(d);

      const catalog = new Map(sedes.map((s) => [s.sede_id, s.siesa_code ?? null]));
      const shiftsByCedula = new Map();
      for (const r of shiftRows) {
        if (!shiftsByCedula.has(r.cedula)) shiftsByCedula.set(r.cedula, []);
        shiftsByCedula.get(r.cedula).push(r);
      }

      const all = [];
      const universe = new Set([...shiftsByCedula.keys(), ...directory.byCedula.keys()]);
      for (const cedula of universe) {
        const shifts = shiftsByCedula.get(cedula) ?? [];
        const person = directory.byCedula.get(cedula) ?? null;
        const { weeks: weekData, totals } = employeeNovelties(shifts.map(toRuleRow), from, to, holidays.set);
        if (!person && totals.workedHours === 0) continue; // only rest rows and unknown: nothing to report

        const last = shifts
          .filter((s) => s.tipo === "TRABAJO" && s.fecha >= from && s.fecha <= to)
          .sort(compareLast)[0];
        // W5: shift snapshot -> sede catalog of that shift -> catalog of the directory sede.
        let siesaCode = null;
        let branchSource = null;
        if (last?.siesa_code) [siesaCode, branchSource] = [last.siesa_code, "shift"];
        else if (last && catalog.get(last.sede_id)) [siesaCode, branchSource] = [catalog.get(last.sede_id), "sede"];
        else if (person?.sedeId && catalog.get(person.sedeId)) [siesaCode, branchSource] = [catalog.get(person.sedeId), "directory"];

        all.push({
          cedula,
          nombre: person?.nombre || null,
          cargo: person?.cargo || last?.cargo || shifts.find((s) => s.cargo)?.cargo || null,
          sedeId: last?.sede_id ?? person?.sedeId ?? null,
          siesaCode,
          branchSource,
          inDirectory: directory.available ? Boolean(person) : null,
          weeks: weekData,
          totals,
        });
      }
      all.sort((a, b) => byText(a.nombre ?? "￿", b.nombre ?? "￿") || byText(a.cedula, b.cedula));

      const rows = all.filter((r) => canAccessSede(access, r.sedeId) && (sedeId === undefined || r.sedeId === sedeId));

      // SIESA: only rows with hours to export; those without a branch block the export instead (A4).
      const exportable = rows.filter((r) => hasConcepts(r.totals));
      const siesa = {
        headers: [...SIESA_HEADERS],
        rows: siesaTuples(exportable.filter((r) => r.siesaCode)),
        errors: exportable
          .filter((r) => !r.siesaCode)
          .map((r) => ({ cedula: r.cedula, nombre: r.nombre, code: "MISSING_BRANCH" })),
      };

      const totals = { employees: rows.length };
      for (const k of CONCEPTS) totals[k] = roundHours(rows.reduce((acc, r) => acc + r.totals[k], 0));

      const inScope = (id) => canAccessSede(access, id) && (sedeId === undefined || id === sedeId);
      const warnings = [];
      const push = (code, extra) => warnings.push({ code, ...extra });

      // Sede-weeks that have work in the period, from the shifts themselves.
      const scheduleState = new Map(schedules.map((s) => [`${s.sede_id}|${s.week_start}`, s.state]));
      const worked = new Set(
        shiftRows
          .filter((s) => s.tipo === "TRABAJO" && s.fecha >= from && s.fecha <= to && inScope(s.sede_id))
          .map((s) => `${s.sede_id}|${mondayOf(s.fecha)}`),
      );
      const unpublished = [...worked]
        .filter((k) => scheduleState.get(k) === "BORRADOR")
        .map((k) => ({ sedeId: k.split("|")[0], weekStart: k.split("|")[1] }))
        .sort((a, b) => byText(a.sedeId, b.sedeId) || byText(a.weekStart, b.weekStart));
      if (unpublished.length) push("UNPUBLISHED_WEEKS", { items: unpublished });

      const unscheduled = [];
      for (const s of sedes.filter((x) => x.activo !== false && inScope(x.sede_id))) {
        for (const w of weeks) {
          if (!scheduleState.has(`${s.sede_id}|${w.weekStart}`)) unscheduled.push({ sedeId: s.sede_id, weekStart: w.weekStart });
        }
      }
      unscheduled.sort((a, b) => byText(a.sedeId, b.sedeId) || byText(a.weekStart, b.weekStart));
      if (unscheduled.length) push("SEDE_WEEK_WITHOUT_SCHEDULE", { items: unscheduled });

      const notInDirectory = rows.filter((r) => r.inDirectory === false && r.totals.workedHours > 0).map((r) => r.cedula);
      if (notInDirectory.length) push("NOT_IN_DIRECTORY", { cedulas: notInDirectory });
      const missingBranch = exportable.filter((r) => !r.siesaCode).map((r) => r.cedula);
      if (missingBranch.length) push("MISSING_BRANCH", { cedulas: missingBranch });
      const overlaps = rows.filter((r) => r.weeks.some((w) => w.hasOverlap)).map((r) => r.cedula);
      if (overlaps.length) push("SHIFT_OVERLAP_DEDUPED", { cedulas: overlaps });
      if (paidCut) push("PERIOD_OVERLAPS_PAID_CUT", { cut: paidCut });
      if (to >= today) push("PERIOD_NOT_FINISHED");
      if (!directory.available) push("DIRECTORY_UNAVAILABLE");

      return {
        source: "live",
        period: { from, to, days: diffDays(to, from) + 1, isDefault, weeks },
        calendar: { sundays, holidays: holidays.list },
        rows,
        totals,
        siesa,
        warnings,
        paidCut: paidCut ?? null,
        cut: null,
        variations: null, // slice 3
        fingerprint: access.role === "admin" && sedeId === undefined ? fingerprintOf(all, holidays.list) : null,
        // Slice 2 enables saving/voiding cuts; there is no save endpoint yet.
        permissions: { canSaveCut: false, canVoidCut: false },
      };
    },
  };
}
