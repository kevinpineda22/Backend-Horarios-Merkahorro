import { createHttpError } from "../../shared/http/HttpError.js";
import { canAccessSede } from "../../shared/http/authorize.js";
import { addDays } from "../sugerido/domain/dates.js";
import { normalizeWeekPayload } from "./domain/weekPayload.js";
import { publishBlockers, weekWarnings } from "./domain/weekRules.js";
import { diffSnapshotRows } from "./domain/snapshotDiff.js";

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
 * The routes already filter roles and sedes; every use case re-checks sede access (and writes the role) so the service is safe on its own.
 */
export function createHorariosService({ repo, profilesRepo, snapshotsRepo = null, logger = console }) {
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

  /** Freezes recommendation + suggestion (as the client sent them) + the published rows. true when stored. */
  async function saveSnapshot(schedule, user, snapshot) {
    if (!snapshotsRepo) return false;
    try {
      await snapshotsRepo.create({
        scheduleId: schedule.id,
        sedeId: schedule.sede_id,
        weekStart: schedule.week_start,
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

  async function toScheduleDto(row, sedeId, weekStart, nameOf) {
    if (!row) {
      return {
        sedeId, weekStart, state: "BORRADOR", version: 0,
        updatedBy: null, updatedByName: null, updatedAt: null,
        publishedBy: null, publishedByName: null, publishedAt: null,
      };
    }
    return {
      sedeId: row.sede_id,
      weekStart: row.week_start,
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

  // Rows of the same people in every other sede around the week (previous Sunday .. next Monday).
  const neighborRows = (cedulas, weekStart, excludeScheduleId) =>
    repo.listShiftsByCedulas({ cedulas, from: addDays(weekStart, -1), to: addDays(weekStart, 7), excludeScheduleId });

  return {
    async get(access, sedeId, weekStart) {
      assertCanRead(access, sedeId);
      await assertSede(sedeId);
      const nameOf = nameResolver();
      const schedule = await repo.findSchedule(sedeId, weekStart);
      const rows = schedule ? await repo.listShifts(schedule.id) : [];
      return {
        schedule: await toScheduleDto(schedule, sedeId, weekStart, nameOf),
        shifts: rows.map(toShiftDto),
        permissions: permissionsFor(access, sedeId),
      };
    },

    /**
     * PUBLICADO -> BORRADOR so the team stops seeing the week. Checks run in the contract order (404, not published,
     * stale version, paid payroll cut) for clear errors; the RPC repeats them under the week lock for concurrency safety.
     */
    async unpublish(access, user, sedeId, weekStart, { expectedVersion }) {
      assertCanWrite(access, sedeId);
      await assertSede(sedeId);
      const schedule = await repo.findSchedule(sedeId, weekStart);
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

      await repo.unpublishWeek({ sedeId, weekStart, expectedVersion, actor: user.id });
      const draft = await repo.findSchedule(sedeId, weekStart);
      return { schedule: await toScheduleDto(draft, sedeId, weekStart, nameResolver()), warnings: [] };
    },

    /** Schedules of a sede by state, newest week first, with their head-count. Two repo calls, no N+1. */
    async listSchedules(access, sedeId, { status, limit }) {
      assertCanRead(access, sedeId);
      await assertSede(sedeId);
      const rows = await repo.listSchedules({ sedeId, status, limit });
      if (rows.length === 0) return [];
      const counts = await repo.countPeople(rows.map((r) => r.id));
      const nameOf = nameResolver();
      return Promise.all(
        rows.map(async (r) => ({
          weekStart: r.week_start,
          status: r.state,
          version: r.version,
          publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
          publishedBy: await nameOf(r.published_by),
          peopleCount: counts[r.id] ?? 0,
        })),
      );
    },

    async save(access, user, sedeId, weekStart, { expectedVersion, cedulas, shifts }) {
      assertCanWrite(access, sedeId);
      await assertSede(sedeId);
      const normalized = normalizeWeekPayload({ weekStart, cedulas, shifts });

      // The payload replaces the sent cedulas of this sede-week; everything else comes from other schedules.
      const current = await repo.findSchedule(sedeId, weekStart);
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

      await repo.saveWeek({ sedeId, weekStart, expectedVersion, cedulas, shifts: normalized, actor: user.id });

      const nameOf = nameResolver();
      const saved = await repo.findSchedule(sedeId, weekStart);
      const rows = await repo.listShifts(saved.id);
      return { schedule: await toScheduleDto(saved, sedeId, weekStart, nameOf), shifts: rows.map(toShiftDto), warnings };
    },

    async publish(access, user, sedeId, weekStart, { expectedVersion, snapshot = null }) {
      assertCanWrite(access, sedeId);
      await assertSede(sedeId);
      const nameOf = nameResolver();
      const schedule = await repo.findSchedule(sedeId, weekStart);
      if (!schedule) {
        throw createHttpError(404, "Todavía no hay un horario guardado para esta semana.", "SCHEDULE_NOT_FOUND");
      }

      // Idempotent: whatever the version, a published week is returned as it is. No blockers are evaluated.
      if (schedule.state === "PUBLICADO") {
        return { schedule: await toScheduleDto(schedule, sedeId, weekStart, nameOf), warnings: [], alreadyPublished: true };
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

      const stored = (await repo.listShifts(schedule.id)).map(toRuleRow);
      const scope = workingCedulas(stored);
      const others = scope.length ? await neighborRows(scope, weekStart, schedule.id) : [];
      const ruleRows = [...stored.filter((r) => scope.includes(r.cedula)), ...others.map(toRuleRow)];

      const blockers = publishBlockers(ruleRows, weekStart, scope);
      if (blockers.length) {
        const err = createHttpError(422, "El horario tiene bloqueos que impiden publicarlo.", "PUBLISH_BLOCKED");
        err.details = { blockers };
        throw err;
      }

      const result = await repo.publishWeek({ sedeId, weekStart, expectedVersion, actor: user.id });
      const published = await repo.findSchedule(sedeId, weekStart);
      const snapshotSaved = result?.noop ? false : await saveSnapshot(published, user, snapshot);
      return {
        schedule: await toScheduleDto(published, sedeId, weekStart, nameOf),
        warnings: weekWarnings(ruleRows, weekStart, scope),
        alreadyPublished: Boolean(result?.noop),
        snapshotSaved,
      };
    },

    /** Publish snapshots of a sede, newest first: who published, when, and how much differs from the suggestion. */
    async listSnapshots(access, sedeId, { limit }) {
      assertCanRead(access, sedeId);
      await assertSede(sedeId);
      const nameOf = nameResolver();
      const rows = await snapshotsRepo.listBySede({ sedeId, limit });
      return Promise.all(
        rows.map(async (s) => ({
          id: s.id,
          weekStart: s.weekStart,
          scheduleVersion: s.scheduleVersion,
          publishedAt: s.publishedAt,
          publishedBy: await nameOf(s.publishedBy),
          hasRecommendation: s.recommendation !== null,
          hasSuggestion: s.suggested !== null,
          diff: diffSnapshotRows(s.suggested?.shifts ?? null, s.published),
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
        scheduleVersion: s.scheduleVersion,
        publishedAt: s.publishedAt,
        publishedBy: await nameResolver()(s.publishedBy),
        recommendation: s.recommendation,
        suggested: s.suggested,
        published: s.published,
        diff: diffSnapshotRows(s.suggested?.shifts ?? null, s.published),
      };
    },

    async history(access, sedeId, weekStart, limit) {
      assertCanRead(access, sedeId);
      await assertSede(sedeId);
      const schedule = await repo.findSchedule(sedeId, weekStart);
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
