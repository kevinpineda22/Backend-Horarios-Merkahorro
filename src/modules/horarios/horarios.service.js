import { createHttpError } from "../../shared/http/HttpError.js";
import { normalizeCedula } from "../../shared/cedula.js";
import { canAccessSede } from "../../shared/http/authorize.js";
import { addDays } from "../sugerido/domain/dates.js";
import { normalizeWeekPayload } from "./domain/weekPayload.js";
import { publishBlockers, weekWarnings } from "./domain/weekRules.js";
import { diffSnapshotRows } from "./domain/snapshotDiff.js";
import { sanitizeSegmentsForShifts } from "./domain/segments.js";
import { TEAM_CAJEROS } from "./domain/teams.js";
import { TEAM_OVERTIME_HOURS, teamOvertimeMinutes } from "./domain/teamOvertime.js";

const WRITER_ROLES = ["admin", "planner"];

// "08:00:00" (Postgres time) -> "08:00". "24:00:00" -> "24:00".
const hhmm = (t) => (t == null ? null : String(t).slice(0, 5));

const toShiftDto = (r) => ({
  id: r.id,
  siesaCode: r.siesa_code ?? null,
  cedula: r.cedula,
  fecha: r.fecha,
  tipo: r.tipo,
  startTime: hhmm(r.start_time),
  endTime: hhmm(r.end_time),
  breakMinutes: r.break_minutes ?? 0,
  lunchStart: hhmm(r.lunch_start),
  cargo: r.cargo ?? null,
  observacion: r.observacion ?? null,
});

// The shape weekRules works with: the shift plus the sede it belongs to.
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

const payloadRuleRow = (sedeId) => (s) => ({
  cedula: s.cedula,
  sedeId,
  fecha: s.fecha,
  tipo: s.tipo,
  startTime: s.startTime,
  endTime: s.endTime,
  breakMinutes: s.breakMinutes,
  lunchStart: s.lunchStart,
});

const workingCedulas = (ruleRows) => [...new Set(ruleRows.filter((r) => r.tipo === "TRABAJO").map((r) => r.cedula))];

const forbiddenRole = () => createHttpError(403, "No tienes permisos para realizar esta acción.", "FORBIDDEN_ROLE");
const forbiddenSede = () => createHttpError(403, "No tienes acceso a esta sede.", "FORBIDDEN_SEDE");

// One published row as the publish snapshot keeps it (no ids, sede code, cargo or notes: only what the comparison needs).
const toSnapshotRow = (r) => {
  const dto = toShiftDto(r);
  return { cedula: dto.cedula, fecha: dto.fecha, tipo: dto.tipo, startTime: dto.startTime, endTime: dto.endTime, breakMinutes: dto.breakMinutes, lunchStart: dto.lunchStart };
};

/**
 * Shift persistence use cases. Ports:
 *   repo          findSede / findSchedule / listShifts / listShiftsByCedulas / saveWeek / publishWeek / listHistory
 *   profilesRepo  findById (names of actors)
 *   snapshotsRepo create (migration 013): what was recommended, suggested and published, frozen on every publication.
 *                 Optional; a failure is logged and never blocks publishing.
 *   overtimeRepo  listByWeek(sedeId, weekStart) -> [{ hours, status }]. Optional (null = no approved overtime): the cashier team may
 *                 not be published above 10 h + the approved overtime of the week. A read error propagates (fail closed).
 * The routes already filter roles and sedes; every use case re-checks sede access (and writes the role) so the service is safe on its own.
 */
export function createHorariosService({ repo, profilesRepo, snapshotsRepo = null, overtimeRepo = null, loansRepo = null, logger = console }) {
  async function assertSede(sedeId) {
    if (!(await repo.findSede(sedeId))) throw createHttpError(404, "Sede no encontrada.", "SEDE_NOT_FOUND");
  }

  function assertCanWrite(access, sedeId) {
    if (!access || !WRITER_ROLES.includes(access.role)) throw forbiddenRole();
    if (!canAccessSede(access, sedeId)) throw forbiddenSede();
  }

  function assertCanRead(access, sedeId) {
    if (!canAccessSede(access, sedeId)) throw forbiddenSede();
  }

  /**
   * A person lent to another sede for the week belongs to that sede's team: this sede cannot save shifts for her. Only the
   * cedulas that have rows in the payload are checked (clearing a person never fails).
   */
  async function assertNotLentOut(sedeId, weekStart, normalized) {
    if (!loansRepo) return;
    const cedulas = [...new Set(normalized.map((s) => normalizeCedula(s.cedula)))];
    if (cedulas.length === 0) return;
    const loans = await loansRepo.listActiveLentOut({ sedeId, weekStart, cedulas });
    if (loans.length === 0) return;
    const hostId = loans[0].hostSedeId;
    const host = await repo.findSede(hostId);
    const err = createHttpError(
      409,
      `Esta persona está prestada a ${host?.nombre ?? hostId} esa semana: no puedes programarla en esta sede.`,
      "EMPLOYEE_LENT",
    );
    err.details = { loans: loans.map((l) => ({ cedula: l.cedula, hostSedeId: l.hostSedeId })) };
    throw err;
  }

  /** Freezes recommendation + suggestion (as the client sent them) + the published rows. true when stored. */
  async function saveSnapshot(schedule, user, snapshot) {
    if (!snapshotsRepo) return false;
    try {
      await snapshotsRepo.create({
        scheduleId: schedule.id,
        sedeId: schedule.sede_id,
        weekStart: schedule.week_start,
        teamKey: schedule.team_key ?? TEAM_CAJEROS,
        scheduleVersion: schedule.version,
        publishedBy: user.id,
        recommendation: snapshot?.recommendation ?? null,
        suggested: snapshot?.suggested ?? null,
        published: (await repo.listShifts(schedule.id)).map(toSnapshotRow),
      });
      return true;
    } catch (err) {
      logger?.error?.("[horarios] publish snapshot not saved", { sedeId: schedule.sede_id, weekStart: schedule.week_start, message: err?.message });
      return false;
    }
  }

  /** Segments the client sent -> only those that fit the shifts; null when there is nothing to freeze. */
  function freezableSegments(shifts, input, context) {
    const { items, dropped } = sanitizeSegmentsForShifts(shifts, input);
    if (dropped) logger?.warn?.("[horarios] segments dropped: they do not fit the shifts", { ...context, dropped });
    return Array.isArray(input) ? items : null;
  }

  /**
   * Cashier team overtime budget: 10 h + approved requests of the sede-week. The requests are read only when `minutes`
   * exceeds the base 10 h, and a read error propagates (fail closed). Exactly at budget is allowed.
   */
  async function assertWithinOvertimeBudget(sedeId, weekStart, minutes) {
    const baseMinutes = TEAM_OVERTIME_HOURS * 60;
    if (minutes <= baseMinutes) return;
    const requests = overtimeRepo ? await overtimeRepo.listByWeek(sedeId, weekStart) : [];
    const approvedHours = requests.filter((r) => r.status === "APROBADA").reduce((sum, r) => sum + Number(r.hours || 0), 0);
    const budgetMinutes = baseMinutes + Math.round(approvedHours * 60);
    if (minutes <= budgetMinutes) return;
    const err = createHttpError(
      422,
      "El equipo de cajeros supera las horas extra aprobadas para esta semana. Solicita las horas extra y espera la aprobación.",
      "OVERTIME_NOT_APPROVED",
    );
    err.details = {
      overtimeHours: minutes / 60,
      budgetHours: budgetMinutes / 60,
      approvedHours,
      missingHours: (minutes - budgetMinutes) / 60,
      pending: requests.some((r) => r.status === "PENDIENTE"),
    };
    throw err;
  }

  const permissionsFor = (access, sedeId) => {
    const can = Boolean(access) && WRITER_ROLES.includes(access.role) && canAccessSede(access, sedeId);
    return { canEdit: can, canPublish: can };
  };

  function nameResolver() {
    const cache = new Map();
    return async (userId) => {
      if (!userId) return null;
      if (!cache.has(userId)) cache.set(userId, profilesRepo.findById(userId).then((p) => p?.nombre ?? null));
      return cache.get(userId);
    };
  }

  async function toScheduleDto(row, sedeId, weekStart, nameOf, teamKey = TEAM_CAJEROS) {
    if (!row) {
      return {
        sedeId, weekStart, teamKey, state: "BORRADOR", version: 0,
        updatedBy: null, updatedByName: null, updatedAt: null,
        publishedBy: null, publishedByName: null, publishedAt: null,
      };
    }
    return {
      sedeId: row.sede_id,
      weekStart: row.week_start,
      teamKey: row.team_key ?? teamKey,
      state: row.state,
      version: row.version,
      updatedBy: row.updated_by ?? null,
      updatedByName: await nameOf(row.updated_by),
      updatedAt: row.updated_at ?? null,
      publishedBy: row.published_by ?? null,
      publishedByName: await nameOf(row.published_by),
      publishedAt: row.published_at ?? null,
    };
  }

  // Cashiers first, then the other teams alphabetically.
  const teamOf = (r) => r.team_key ?? TEAM_CAJEROS;
  const byTeam = (a, b) =>
    (teamOf(a) === TEAM_CAJEROS ? -1 : teamOf(b) === TEAM_CAJEROS ? 1 : 0) || teamOf(a).localeCompare(teamOf(b));

  const toIso = (value) => (value ? new Date(value).toISOString() : null);

  // Rows of the same people in every other sede around the week (previous Sunday .. next Monday).
  const neighborRows = (cedulas, weekStart, excludeScheduleId) =>
    repo.listShiftsByCedulas({ cedulas, from: addDays(weekStart, -1), to: addDays(weekStart, 7), excludeScheduleId });

  return {
    /** One team schedule of the sede-week plus a `teams` summary of every team schedule of that week. */
    async get(access, sedeId, weekStart, teamKey = TEAM_CAJEROS) {
      assertCanRead(access, sedeId);
      await assertSede(sedeId);
      const nameOf = nameResolver();
      const schedule = await repo.findSchedule(sedeId, weekStart, teamKey);
      const rows = schedule ? await repo.listShifts(schedule.id) : [];
      const teamRows = [...(await repo.listTeamSchedules(sedeId, weekStart))].sort(byTeam);
      const counts = teamRows.length ? await repo.countPeople(teamRows.map((r) => r.id)) : {};
      const teams = await Promise.all(
        teamRows.map(async (r) => ({
          teamKey: r.team_key ?? TEAM_CAJEROS,
          state: r.state,
          version: r.version,
          publishedAt: r.published_at ?? null,
          publishedBy: await nameOf(r.published_by),
          peopleCount: counts[r.id] ?? 0,
        })),
      );
      return {
        schedule: await toScheduleDto(schedule, sedeId, weekStart, nameOf, teamKey),
        shifts: rows.map(toShiftDto),
        teams,
        permissions: permissionsFor(access, sedeId),
      };
    },

    /**
     * PUBLICADO -> BORRADOR so the team stops seeing the week. Checks run in the contract order (404, not published,
     * stale version, paid payroll cut) for clear errors; the RPC repeats them under the week lock for concurrency safety.
     */
    async unpublish(access, user, sedeId, weekStart, { expectedVersion }, teamKey = TEAM_CAJEROS) {
      assertCanWrite(access, sedeId);
      await assertSede(sedeId);
      const schedule = await repo.findSchedule(sedeId, weekStart, teamKey);
      if (!schedule) {
        throw createHttpError(404, "Todavía no hay un horario guardado para esta semana.", "SCHEDULE_NOT_FOUND");
      }
      if (schedule.state !== "PUBLICADO") throw createHttpError(409, "Este horario no está publicado.", "NOT_PUBLISHED");
      if (schedule.version !== expectedVersion) {
        const err = createHttpError(
          409,
          "Otra persona guardó cambios en este horario. Carga la versión guardada para continuar.",
          "VERSION_CONFLICT",
        );
        err.details = { currentVersion: schedule.version };
        throw err;
      }
      const paidCut = await repo.findPaidCutOverlapping(weekStart, addDays(weekStart, 6));
      if (paidCut) {
        const err = createHttpError(409, "No puedes despublicar: esta semana ya está en un corte de nómina pagado.", "PAYROLL_CUT_PAID");
        err.details = { cut: paidCut };
        throw err;
      }

      await repo.unpublishWeek({ sedeId, weekStart, teamKey, expectedVersion, actor: user.id });
      const draft = await repo.findSchedule(sedeId, weekStart, teamKey);
      return { schedule: await toScheduleDto(draft, sedeId, weekStart, nameResolver(), teamKey), warnings: [] };
    },

    /**
     * Weeks of a sede that have at least one team schedule in `status`, newest first, one item per WEEK. Two repo calls.
     * `status` of the item is the requested one (the week qualifies because some team has it); `peopleCount`,
     * `publishedAt` and `publishedBy` aggregate only the teams in that state (latest publication wins); `version` is the
     * cashier team's when it matches, else the first matching team's. `teams` lists every team of the week.
     */
    async listSchedules(access, sedeId, { status, limit }) {
      assertCanRead(access, sedeId);
      await assertSede(sedeId);
      const rows = await repo.listSchedules({ sedeId, status, limit });
      if (rows.length === 0) return [];
      const counts = await repo.countPeople(rows.map((r) => r.id));
      const nameOf = nameResolver();

      const weeks = new Map();
      for (const r of rows) {
        if (!weeks.has(r.week_start)) weeks.set(r.week_start, []);
        weeks.get(r.week_start).push(r);
      }

      return Promise.all(
        [...weeks.entries()].map(async ([weekStart, weekRows]) => {
          const teamRows = [...weekRows].sort(byTeam);
          // The repo only returns weeks with a team in `status`; the fallback keeps an odd row set from crashing the list.
          const inStatus = teamRows.filter((r) => r.state === status);
          const matching = inStatus.length ? inStatus : teamRows;
          const weekStatus = inStatus.length ? status : teamRows.some((r) => r.state === "PUBLICADO") ? "PUBLICADO" : "BORRADOR";
          const latest = matching
            .filter((r) => r.state === "PUBLICADO")
            .reduce((best, r) => (!best || new Date(r.published_at) > new Date(best.published_at) ? r : best), null);
          return {
            weekStart,
            status: weekStatus,
            version: (matching.find((r) => r.team_key === TEAM_CAJEROS) ?? matching[0]).version,
            publishedAt: toIso(latest?.published_at),
            publishedBy: latest ? await nameOf(latest.published_by) : null,
            peopleCount: matching.reduce((sum, r) => sum + (counts[r.id] ?? 0), 0),
            teams: await Promise.all(
              teamRows.map(async (r) => ({
                teamKey: r.team_key,
                status: r.state,
                version: r.version,
                publishedAt: toIso(r.published_at),
                publishedBy: await nameOf(r.published_by),
                peopleCount: counts[r.id] ?? 0,
              })),
            ),
          };
        }),
      );
    },

    async save(access, user, sedeId, weekStart, { expectedVersion, cedulas, shifts, segments = null }, teamKey = TEAM_CAJEROS) {
      assertCanWrite(access, sedeId);
      await assertSede(sedeId);
      const normalized = normalizeWeekPayload({ weekStart, cedulas, shifts });
      await assertNotLentOut(sedeId, weekStart, normalized);

      // The payload replaces the sent cedulas of this sede-week; everything else comes from other schedules.
      const current = await repo.findSchedule(sedeId, weekStart, teamKey);
      const others = await neighborRows(cedulas, weekStart, current?.id ?? null);
      const ruleRows = [...normalized.map(payloadRuleRow(sedeId)), ...others.map(toRuleRow)];
      const scope = workingCedulas(normalized);
      const warnings = [
        ...publishBlockers(ruleRows, weekStart, scope).map((b) => ({ ...b, blocking: false })),
        ...weekWarnings(ruleRows, weekStart, scope),
      ];

      // A published week feeds payroll: once a paid cut covers it, editing is refused (same guard as unpublish).
      if (current?.state === "PUBLICADO") {
        const paidCut = await repo.findPaidCutOverlapping(weekStart, addDays(weekStart, 6));
        if (paidCut) {
          const err = createHttpError(409, "No puedes editar: esta semana ya está en un corte de nómina pagado.", "PAYROLL_CUT_PAID");
          err.details = { cut: paidCut };
          throw err;
        }
      }

      // Editing a published cashier week may not raise the team overtime above its budget. Already over: correcting down or
      // leaving it equal stays possible. Drafts are never checked here (publishing is the gate).
      // A stale version skips it: saveWeek answers VERSION_CONFLICT, which is what the leader must solve first.
      if (current?.state === "PUBLICADO" && teamKey === TEAM_CAJEROS && current.version === expectedVersion) {
        const storedRows = (await repo.listShifts(current.id)).map(toRuleRow);
        const after = [...storedRows.filter((r) => !cedulas.includes(r.cedula)), ...normalized.map(payloadRuleRow(sedeId))];
        const afterMinutes = teamOvertimeMinutes(after);
        if (afterMinutes > teamOvertimeMinutes(storedRows)) await assertWithinOvertimeBudget(sedeId, weekStart, afterMinutes);
      }

      // Only an already published week keeps a frozen split; the saved shifts are the truth the segments must fit.
      const frozen = current?.state === "PUBLICADO" ? freezableSegments(normalized, segments, { sedeId, weekStart }) : null;
      await repo.saveWeek({ sedeId, weekStart, teamKey, expectedVersion, cedulas, shifts: normalized, actor: user.id, segments: frozen });

      const nameOf = nameResolver();
      const saved = await repo.findSchedule(sedeId, weekStart, teamKey);
      const rows = await repo.listShifts(saved.id);
      return { schedule: await toScheduleDto(saved, sedeId, weekStart, nameOf, teamKey), shifts: rows.map(toShiftDto), warnings };
    },

    async publish(access, user, sedeId, weekStart, { expectedVersion, snapshot = null, segments = null }, teamKey = TEAM_CAJEROS) {
      assertCanWrite(access, sedeId);
      await assertSede(sedeId);
      const nameOf = nameResolver();
      const schedule = await repo.findSchedule(sedeId, weekStart, teamKey);
      if (!schedule) {
        throw createHttpError(404, "Todavía no hay un horario guardado para esta semana.", "SCHEDULE_NOT_FOUND");
      }

      // Idempotent: whatever the version, a published week is returned as it is. No blockers are evaluated.
      if (schedule.state === "PUBLICADO") {
        return { schedule: await toScheduleDto(schedule, sedeId, weekStart, nameOf, teamKey), warnings: [], alreadyPublished: true };
      }

      if (schedule.version !== expectedVersion) {
        const err = createHttpError(
          409,
          "Otra persona guardó cambios en este horario. Carga la versión guardada para continuar.",
          "VERSION_CONFLICT",
        );
        err.details = { currentVersion: schedule.version };
        throw err;
      }

      // Blockers are evaluated over THIS team's stored rows only; neighborRows still reads every other schedule of the
      // same people (other sedes and sibling teams), which is what the 56 h / rest rules need.
      const storedRows = await repo.listShifts(schedule.id);
      const stored = storedRows.map(toRuleRow);
      const scope = workingCedulas(stored);
      const others = scope.length ? await neighborRows(scope, weekStart, schedule.id) : [];
      const ruleRows = [...stored.filter((r) => scope.includes(r.cedula)), ...others.map(toRuleRow)];

      const blockers = publishBlockers(ruleRows, weekStart, scope);
      if (blockers.length) {
        const err = createHttpError(422, "El horario tiene bloqueos que impiden publicarlo.", "PUBLISH_BLOCKED");
        err.details = { blockers };
        throw err;
      }

      if (teamKey === TEAM_CAJEROS) await assertWithinOvertimeBudget(sedeId, weekStart, teamOvertimeMinutes(stored));

      // Atomic with the state change (migration 014). Absent segments = the old publish, which also works without 014.
      const frozen = freezableSegments(storedRows.map(toShiftDto), segments, { sedeId, weekStart });
      const result = await repo.publishWeek({ sedeId, weekStart, teamKey, expectedVersion, actor: user.id, segments: frozen });
      const published = await repo.findSchedule(sedeId, weekStart, teamKey);
      const snapshotSaved = result?.noop ? false : await saveSnapshot(published, user, snapshot);
      return {
        schedule: await toScheduleDto(published, sedeId, weekStart, nameOf, teamKey),
        warnings: weekWarnings(ruleRows, weekStart, scope),
        alreadyPublished: Boolean(result?.noop),
        snapshotSaved,
        segmentsSaved: Boolean(result?.segmentsSaved),
      };
    },

    /** Publish snapshots of a sede, newest first: who published, when, and how much differs from the suggestion. */
    async listSnapshots(access, sedeId, { limit, team = null }) {
      assertCanRead(access, sedeId);
      await assertSede(sedeId);
      const nameOf = nameResolver();
      const rows = await snapshotsRepo.listBySede({ sedeId, limit, teamKey: team });
      return Promise.all(
        rows.map(async (s) => ({
          id: s.id,
          weekStart: s.weekStart,
          teamKey: s.teamKey,
          scheduleVersion: s.scheduleVersion,
          publishedAt: s.publishedAt,
          publishedBy: await nameOf(s.publishedBy),
          hasRecommendation: s.recommendation !== null,
          hasSuggestion: s.suggested !== null,
          diff: diffSnapshotRows(s.suggested?.shifts ?? null, s.published, s.suggested?.cedulas ?? null),
        })),
      );
    },

    /** One snapshot with its three parts: recommendation, suggestion and published rows. */
    async getSnapshot(access, sedeId, snapshotId) {
      assertCanRead(access, sedeId);
      const s = await snapshotsRepo.findById(snapshotId);
      if (!s || s.sedeId !== sedeId) throw createHttpError(404, "No encontramos esa publicación.", "SNAPSHOT_NOT_FOUND");
      return {
        id: s.id,
        weekStart: s.weekStart,
        teamKey: s.teamKey,
        scheduleVersion: s.scheduleVersion,
        publishedAt: s.publishedAt,
        publishedBy: await nameResolver()(s.publishedBy),
        recommendation: s.recommendation,
        suggested: s.suggested,
        published: s.published,
        diff: diffSnapshotRows(s.suggested?.shifts ?? null, s.published, s.suggested?.cedulas ?? null),
      };
    },

    async history(access, sedeId, weekStart, limit, teamKey = TEAM_CAJEROS) {
      assertCanRead(access, sedeId);
      await assertSede(sedeId);
      const schedule = await repo.findSchedule(sedeId, weekStart, teamKey);
      if (!schedule) return { items: [] };
      const nameOf = nameResolver();
      const rows = await repo.listHistory({ scheduleId: schedule.id, limit });
      const items = await Promise.all(
        rows.map(async (h) => ({
          id: h.id,
          action: h.action,
          shiftId: h.shift_id ?? null,
          cedula: h.cedula ?? null,
          fecha: h.fecha ?? null,
          scheduleVersion: h.schedule_version,
          actor: h.actor,
          actorName: await nameOf(h.actor),
          at: h.at,
          before: h.before ?? null,
          after: h.after ?? null,
        })),
      );
      return { items };
    },
  };
}
