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
const DEFAULT_CUT_LIMIT = 40;
// payroll_cut_lines.cedula check. Shift cedulas always conform, so a line that does not is a zero-hour
// directory row: it cannot be stored and carries no hours, so it is left out of the snapshot.
const CEDULA_FORMAT = /^[0-9]{5,15}$/;
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

const zeroTotals = () => ({ extras: 0, nocturnas: 0, dominicales: 0, festivos: 0 });

// SIESA block of a report: rows with hours and a branch become tuples; rows with hours and no branch block the export (A4).
function siesaOf(rows) {
  const exportable = rows.filter((r) => hasConcepts(r.totals));
  return {
    exportable,
    siesa: {
      headers: [...SIESA_HEADERS],
      rows: siesaTuples(exportable.filter((r) => r.siesaCode)),
      errors: exportable
        .filter((r) => !r.siesaCode)
        .map((r) => ({ cedula: r.cedula, nombre: r.nombre, code: "MISSING_BRANCH" })),
    },
  };
}

function totalsOf(rows) {
  const totals = { employees: rows.length };
  for (const k of CONCEPTS) totals[k] = roundHours(rows.reduce((acc, r) => acc + r.totals[k], 0));
  return totals;
}

// A stored payroll_cuts row (snake_case) as the API shape. `totals`/`employees` are overridden when scoped.
const cutView = (row, nameOf) => ({
  id: Number(row.id),
  from: row.period_start,
  to: row.period_end,
  state: row.state,
  employees: row.employees,
  totals: Object.fromEntries(CONCEPTS.map((k) => [k, Number(row[k])])),
  engineVersion: row.engine_version,
  createdBy: row.created_by,
  createdByName: nameOf(row.created_by),
  createdAt: row.created_at,
  voidedBy: row.voided_by ?? null,
  voidedByName: row.voided_by ? nameOf(row.voided_by) : null,
  voidedAt: row.voided_at ?? null,
  voidReason: row.void_reason ?? null,
});

// Snapshot sent to payroll_cut_save (snake_case keys, read by jsonb_to_recordset). Zero-hour lines included (W6).
function toSnapshot(rows, calendar) {
  return {
    sundays: calendar.sundays,
    holidays: calendar.holidays,
    engineVersion: PAYROLL_ENGINE_VERSION,
    lines: rows
      .filter((r) => CEDULA_FORMAT.test(r.cedula))
      .map((r) => ({
        cedula: r.cedula,
        nombre: r.nombre,
        cargo: r.cargo,
        sede_id: r.sedeId,
        siesa_code: r.siesaCode,
        branch_source: r.branchSource,
        in_directory: Boolean(r.inDirectory),
        worked_hours: r.totals.workedHours,
        extras: r.totals.extras,
        nocturnas: r.totals.nocturnas,
        dominicales: r.totals.dominicales,
        festivos: r.totals.festivos,
        sunday_festive_hours: r.totals.sundayFestiveHours,
        weeks: r.weeks.map((w) => ({
          week_start: w.weekStart,
          worked_hours: w.workedHours,
          extras: w.extras,
          nocturnas: w.nocturnas,
          dominicales: w.dominicales,
          festivos: w.festivos,
          sunday_festive_hours: w.sundayFestiveHours,
          has_overlap: w.hasOverlap,
        })),
      })),
  };
}

/**
 * Payroll report and cut use cases. Ports:
 *   repo              listShiftsInRange / listSchedulesInRange / listSedes
 *                     and the cuts: findPaidCutOverlapping / findLastPaidCut / saveCut / voidCut /
 *                     listCuts / getCut / sumCutLines (the two finders are optional for report-only wiring)
 *   profilesRepo      findById(userId) -> { nombre } (names of who saved/voided; optional)
 *   empleadosService  list(access) -> { data: [{ cedula, nombre, cargo, sedeId }] }
 *   getHolidayFn      (fecha) -> holiday name | null
 *   now               () -> Date (clock, injected for tests)
 * Every employee is computed company-wide (hours count across sedes); rows are filtered by access afterwards.
 */
export function createPayrollService({
  repo,
  empleadosService,
  profilesRepo,
  getHolidayFn = getHoliday,
  now = () => new Date(),
}) {
  function assertAdmin(access) {
    if (access?.role !== "admin") {
      throw createHttpError(403, "No tienes permisos para realizar esta acción.", "FORBIDDEN_ROLE");
    }
  }

  const invalidPeriod = () =>
    createHttpError(400, "El corte debe ser de 1 o 2 semanas completas, de lunes a domingo.", "PAYROLL_PERIOD_INVALID");

  // Stored cuts as API objects. Names are cosmetic: a failing profile lookup leaves the name null.
  async function presentCuts(rows) {
    const names = new Map();
    for (const row of rows) {
      for (const id of [row.created_by, row.voided_by]) {
        if (!id || names.has(id) || !profilesRepo) continue;
        try {
          names.set(id, (await profilesRepo.findById(id))?.nombre ?? null);
        } catch (err) {
          console.error("[payroll] profile lookup failed:", err?.message);
          names.set(id, null);
        }
      }
    }
    const nameOf = (id) => names.get(id) ?? null;
    return rows.map((row) => cutView(row, nameOf));
  }

  function assertCanRead(access, sedeId) {
    if (!access || !READER_ROLES.includes(access.role)) {
      throw createHttpError(403, "No tienes permisos para realizar esta acción.", "FORBIDDEN_ROLE");
    }
    if (sedeId !== undefined && !canAccessSede(access, sedeId)) {
      throw createHttpError(403, "No tienes acceso a esta sede.", "FORBIDDEN_SEDE");
    }
  }

  async function resolvePeriod({ from, to }, today) {
    if (from === undefined && to === undefined) {
      // W2: the cut grid continues the day after the newest PAGADO cut, else the block containing today.
      const lastPaid = repo.findLastPaidCut ? await repo.findLastPaidCut() : null;
      return { ...defaultPeriod({ today, lastPaidEnd: lastPaid?.to ?? null }), isDefault: true };
    }
    if (periodError(from, to)) throw invalidPeriod();
    return { from, to, isDefault: false };
  }

  async function loadDirectory() {
    try {
      const { data } = await empleadosService.list(ADMIN_SCOPE);
      return { byCedula: new Map(data.map((e) => [e.cedula, e])), available: true };
    } catch (err) {
      // Degrade on any failure (not only the outage), but leave a trace; message only, no PII.
      console.error("[payroll] directory unavailable:", err?.message);
      return { byCedula: new Map(), available: false };
    }
  }

  // Live computation shared by the report and the cut save (which needs the unfiltered rows).
  async function compute(access, query) {
  assertCanRead(access, query.sedeId);
  const today = bogotaToday(now());
  const { from, to, isDefault } = await resolvePeriod(query, today);
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

  const { exportable, siesa } = siesaOf(rows);
  const totals = totalsOf(rows);

  const inScope = (id) => canAccessSede(access, id) && (sedeId === undefined || id === sedeId);
  const warnings = [];
  const push = (code, extra) => warnings.push({ code, ...extra });
  // Always present: scheduling only covers what was programmed in this system (today, cashiers only),
  // so a zero-hour row can also mean "not scheduled here".
  push("PARTIAL_COVERAGE");

  // Sede-weeks that have work in the period, from the shifts themselves.
  // Accepted (S1): previous-day spill shifts of a BORRADOR previous week are counted in the hours
  // but that week is not reported here, since it lies outside the period's weeks.
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

  const isAdmin = access.role === "admin";
  const dto = {
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
    fingerprint: isAdmin && sedeId === undefined ? fingerprintOf(all, holidays.list) : null,
    permissions: { canSaveCut: isAdmin && !paidCut, canVoidCut: isAdmin },
  };
  return { dto, all, directoryAvailable: directory.available };
  }

  return {
    async report(access, query = {}) {
      return (await compute(access, query)).dto;
    },

    /**
     * Admin only. The server recomputes the report and never reads numbers from the client: the body
     * carries just the period and the `fingerprint` of the report the admin reviewed. Order: directory
     * (503), paid cut in the way (409), stale fingerprint (409), then the RPC (advisory lock + EXCLUDE).
     *
     * Accepted race (S2): shifts can still change between this recompute and the RPC. The fingerprint
     * proves the admin saw the same data we recomputed; the stored snapshot is exactly what was
     * recomputed here, and the window is a few milliseconds.
     */
    async saveCut(access, user, body = {}) {
      assertAdmin(access);
      const { from, to, fingerprint } = body;
      if (periodError(from, to)) throw invalidPeriod();

      const { dto, all, directoryAvailable } = await compute(access, { from, to });
      if (!directoryAvailable) {
        throw createHttpError(
          503,
          "No pudimos consultar el directorio de empleados. Inténtalo de nuevo en unos minutos.",
          "DIRECTORY_UNAVAILABLE",
        );
      }
      if (dto.paidCut) {
        const err = createHttpError(409, "Ya existe un corte pagado que se cruza con este periodo.", "PAYROLL_CUT_OVERLAP");
        err.details = { cut: dto.paidCut };
        throw err;
      }
      if (!fingerprint || fingerprint !== dto.fingerprint) {
        throw createHttpError(
          409,
          "Los turnos cambiaron desde que cargaste el reporte. Vuélvelo a cargar antes de guardar el corte.",
          "PAYROLL_REPORT_CHANGED",
        );
      }

      const row = await repo.saveCut({ from, to, snapshot: toSnapshot(all, dto.calendar), actor: user.id });
      const [cut] = await presentCuts([row]);
      return { cut };
    },

    /** Admin only: PAGADO -> ANULADO. The reason is optional. */
    async voidCut(access, user, id, body = {}) {
      assertAdmin(access);
      const row = await repo.voidCut({ id, reason: body.reason ?? null, actor: user.id });
      const [cut] = await presentCuts([row]);
      return { cut };
    },

    /** History (ANULADO included, newest first). A scoped planner gets totals of their own sedes only. */
    async listCuts(access, { limit = DEFAULT_CUT_LIMIT } = {}) {
      assertCanRead(access);
      const today = bogotaToday(now());
      const [rows, lastPaid] = await Promise.all([repo.listCuts({ limit }), repo.findLastPaidCut()]);
      const items = await presentCuts(rows);
      if (access.role !== "admin" && access.sedeIds != null) {
        const sums = await repo.sumCutLines({ cutIds: rows.map((r) => Number(r.id)), sedeIds: access.sedeIds });
        for (const item of items) {
          const own = sums.get(item.id);
          item.employees = own?.employees ?? 0;
          item.totals = own ? Object.fromEntries(CONCEPTS.map((k) => [k, own[k]])) : zeroTotals();
        }
      }
      const nextDefaultFrom = lastPaid ? addDays(lastPaid.to, 1) : defaultPeriod({ today }).from;
      return { items, lastPaid: lastPaid ?? null, nextDefaultFrom };
    },

    /** The frozen snapshot of one cut as a report. Nothing is recomputed from shifts. */
    async getCut(access, id, { sedeId } = {}) {
      assertCanRead(access, sedeId);
      const found = await repo.getCut(id);
      if (!found) throw createHttpError(404, "Corte no encontrado.", "PAYROLL_CUT_NOT_FOUND");
      const { cut: cutRow, lines, weeks } = found;
      const from = cutRow.period_start;
      const to = cutRow.period_end;

      const weeksByCedula = new Map();
      for (const w of weeks) {
        if (!weeksByCedula.has(w.cedula)) weeksByCedula.set(w.cedula, []);
        weeksByCedula.get(w.cedula).push({
          weekStart: w.week_start,
          weekEnd: addDays(w.week_start, 6),
          workedHours: Number(w.worked_hours),
          extras: Number(w.extras),
          nocturnas: Number(w.nocturnas),
          dominicales: Number(w.dominicales),
          festivos: Number(w.festivos),
          sundayFestiveHours: Number(w.sunday_festive_hours),
          hasOverlap: Boolean(w.has_overlap),
        });
      }
      const rows = lines
        .map((l) => ({
          cedula: l.cedula,
          nombre: l.nombre ?? null,
          cargo: l.cargo ?? null,
          sedeId: l.sede_id ?? null,
          siesaCode: l.siesa_code ?? null,
          branchSource: l.branch_source ?? null,
          inDirectory: l.in_directory,
          weeks: weeksByCedula.get(l.cedula) ?? [],
          totals: {
            workedHours: Number(l.worked_hours),
            extras: Number(l.extras),
            nocturnas: Number(l.nocturnas),
            dominicales: Number(l.dominicales),
            festivos: Number(l.festivos),
            sundayFestiveHours: Number(l.sunday_festive_hours),
          },
        }))
        .sort((a, b) => byText(a.nombre ?? "￿", b.nombre ?? "￿") || byText(a.cedula, b.cedula))
        .filter((r) => canAccessSede(access, r.sedeId) && (sedeId === undefined || r.sedeId === sedeId));

      const { exportable, siesa } = siesaOf(rows);
      const totals = totalsOf(rows);
      const [cut] = await presentCuts([cutRow]);
      cut.employees = totals.employees;
      cut.totals = Object.fromEntries(CONCEPTS.map((k) => [k, totals[k]]));

      const warnings = [{ code: "PARTIAL_COVERAGE" }];
      const missingBranch = exportable.filter((r) => !r.siesaCode).map((r) => r.cedula);
      if (missingBranch.length) warnings.push({ code: "MISSING_BRANCH", cedulas: missingBranch });

      return {
        source: "cut",
        period: { from, to, days: diffDays(to, from) + 1, isDefault: false, weeks: periodWeeks(from, to) },
        calendar: { sundays: cutRow.sundays, holidays: cutRow.holidays },
        rows,
        totals,
        siesa,
        warnings,
        paidCut: null,
        cut,
        variations: null, // slice 3
        fingerprint: null,
        permissions: { canSaveCut: false, canVoidCut: access.role === "admin" && cutRow.state === "PAGADO" },
      };
    },
  };
}
