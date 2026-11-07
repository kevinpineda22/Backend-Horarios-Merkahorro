import { createHttpError } from "../../shared/http/HttpError.js";
import { canAccessSede } from "../../shared/http/authorize.js";
import { addDays, bogotaToday } from "./domain/dates.js";
import { RECENT_LOOKBACK_DAYS, HOLIDAY_LOOKBACK_DAYS } from "./domain/calendar.js";
import { forecastWeek, TREND_WINDOW_DAYS, YEAR_OFFSET_DAYS } from "./domain/forecast.js";
import { computeProductivity, PRODUCTIVITY_WINDOW_DAYS } from "./domain/productivity.js";
import { assembleWeek, applyOverrides } from "./domain/merge.js";
import { computeFreshness } from "./domain/freshness.js";
import { isWeekInRange } from "./domain/weekRange.js";
import { capSlots, countOverRegisters, derivedRegisters, effectiveRegisters, registersWarning } from "./domain/registers.js";

const METHOD = "forecast-blend-v1";
// The derived register count changes on the scale of months, so read paths reuse it for a few minutes.
const REGISTERS_CACHE_TTL_MS = 10 * 60 * 1000;
// Sales history needed before the target week: the longest look-back any domain module walks.
export const HISTORY_LOOKBACK_DAYS = Math.max(
  HOLIDAY_LOOKBACK_DAYS,
  RECENT_LOOKBACK_DAYS,
  YEAR_OFFSET_DAYS + TREND_WINDOW_DAYS,
  PRODUCTIVITY_WINDOW_DAYS,
);
// Only the tunable parameters are snapshotted (not who edited them or when).
const SNAPSHOT_KEYS = [
  "ordinaryWeeklyHours", "overtimeWeeklyHours", "dailyMaxHours", "utilization",
  "maxWorkingDaysPerWeek", "minCashiers", "staleAfterDays", "blockingAbsenceTypes",
];

const snapshotOf = (settings) => {
  const out = Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, settings[k]]));
  return { ...out, blockingAbsenceTypes: [...out.blockingAbsenceTypes] };
};

/**
 * A planner may add coverage outside the historical pattern (a slot the run did not suggest), so such
 * overrides are kept and shown: final = override, with no suggestion or requirement to compare against.
 */
const orphanOverrideSlots = (day, overrides) => {
  const known = new Set(day.slots.map((s) => s.franja));
  return overrides
    .filter((o) => o.fecha === day.fecha && !known.has(o.franja))
    .map((o) => ({
      franja: o.franja, forecastDocs: 0, required: null, available: null, suggested: null, shortfall: null, status: "unknown",
      override: o.headcount, final: o.headcount, difference: null,
    }));
};

// 'HH:MM' zero-padded strings order correctly with a plain comparison (no locale involved).
const byFranja = (a, b) => (a.franja < b.franja ? -1 : a.franja > b.franja ? 1 : 0);

const emptyWeek = (sedeId, weekStart, registers) => ({ sedeId, weekStart, run: null, freshness: null, flags: null, warnings: [], registers, days: [] });

const toRegisters = (derived, override) => ({ derived, override: override ?? null, effective: effectiveRegisters({ derived, override }) });

/**
 * Sugerido use cases. Everything external is injected (repos, ports, clock), so the service is
 * testable offline. Authorization (role / sede scope) is enforced by the routes; the service only
 * resolves the sede and applies business rules.
 */
export function createSugeridoService({ suggestionsRepo, settingsRepo, salesRepo, staffPort, absencesPort, now = () => new Date() }) {
  // bodega -> { count, at }. Only the read paths use it; a run always asks the database.
  const registersCache = new Map();

  /**
   * Current derived register count per bodega, from the cache or one query for the bodegas still missing.
   * A failing source degrades to "unknown" (stale cache if any): displaying a sede or validating an edit
   * must not depend on the analytics database being up.
   */
  async function derivedByBodega(bodegas) {
    const at = now().getTime();
    const missing = [...new Set(bodegas)].filter((b) => !registersCache.has(b) || at - registersCache.get(b).at >= REGISTERS_CACHE_TTL_MS);
    if (missing.length > 0) {
      try {
        const counts = await salesRepo.loadRegisterCounts({ bodegas: missing });
        for (const b of missing) registersCache.set(b, { count: counts[b] ?? 0, at });
      } catch {
        // keep whatever is cached
      }
    }
    return Object.fromEntries(bodegas.map((b) => [b, registersCache.get(b)?.count ?? 0]));
  }

  async function currentRegisters(sede) {
    return toRegisters(derivedRegisters(sede.bodegas, await derivedByBodega(sede.bodegas)), sede.registersOverride);
  }

  /**
   * One run -> the week view. Freshness is derived from the clock here, never read from storage.
   * `registers` is the CURRENT state of the sede; `inputs.registers` is the snapshot the run was computed with.
   */
  function composeWeek(sedeId, weekStart, run, overrides, registers) {
    const { days: dayMeta, capacity, ...inputs } = run.inputs;
    const slotsByDay = new Map();
    for (const s of run.slots) {
      const slot = {
        franja: s.franja, forecastDocs: s.forecastDocs, required: s.required, available: s.available,
        suggested: s.suggested, shortfall: s.shortfall, status: s.status,
      };
      slotsByDay.set(s.fecha, [...(slotsByDay.get(s.fecha) ?? []), slot]);
    }
    const days = applyOverrides(dayMeta.map((d) => ({ ...d, slots: slotsByDay.get(d.fecha) ?? [] })), overrides).map((d) => ({
      ...d,
      slots: [
        ...d.slots.map(({ diff, ...slot }) => ({ ...slot, difference: diff })),
        ...orphanOverrideSlots(d, overrides),
      ].sort(byFranja),
    }));

    return {
      sedeId,
      weekStart,
      run: { id: run.id, version: run.version, method: run.method, createdAt: run.createdAt, createdBy: run.createdBy, persisted: run.id !== null },
      settings: run.settings,
      freshness: computeFreshness({ dataAsOf: run.dataAsOf, today: bogotaToday(now()), staleAfterDays: run.settings.staleAfterDays }),
      flags: run.flags,
      warnings: run.warnings,
      registers,
      inputs,
      capacity,
      days,
    };
  }

  /** Rejects weeks outside the allowed window before any source or repository is touched. */
  function assertWeekInRange(weekStart) {
    if (!isWeekInRange(weekStart, bogotaToday(now()))) throw createHttpError(400, "La semana está fuera del rango permitido.", "WEEK_OUT_OF_RANGE");
  }

  const loadOverrides = (sedeId, weekStart) =>
    suggestionsRepo.getOverrides(sedeId, { desde: weekStart, hasta: addDays(weekStart, 6) });

  async function readWeek(sede, weekStart) {
    const registers = await currentRegisters(sede);
    const run = await suggestionsRepo.getLatestRun(sede.sedeId, weekStart);
    if (!run) return emptyWeek(sede.sedeId, weekStart, registers);
    return composeWeek(sede.sedeId, weekStart, run, await loadOverrides(sede.sedeId, weekStart), registers);
  }

  return {
    /** Active sedes the caller may see: admins and all-sedes callers get all, scoped callers their own. */
    async listSedes(access) {
      const sedes = (await suggestionsRepo.listSedes()).filter((s) => canAccessSede(access, s.sedeId));
      const counts = sedes.length > 0 ? await derivedByBodega(sedes.flatMap((s) => s.bodegas)) : {};
      return sedes.map(({ registersOverride, ...sede }) => ({ ...sede, registers: toRegisters(derivedRegisters(sede.bodegas, counts), registersOverride) }));
    },

    /** Admin sets (1..50) or clears (null) the manual register count. Only runs computed afterwards use it. */
    async setRegistersOverride(sedeId, override) {
      await suggestionsRepo.getSede(sedeId); // unmapped / inactive -> 404 before any write
      const sede = await suggestionsRepo.setRegistersOverride(sedeId, override);
      return currentRegisters(sede);
    },

    /** Global tunable parameters (admin-only at the route). */
    getSettings() {
      return settingsRepo.getSettings();
    },

    /** Partial update. The patch is already validated; the repo stamps who and when. */
    updateSettings(user, patch) {
      return settingsRepo.updateSettings(patch, user.id);
    },

    async computeRun(user, sedeId, weekStart) {
      assertWeekInRange(weekStart);
      const sede = await suggestionsRepo.getSede(sedeId); // unmapped / inactive -> 404 before any source
      const settings = await settingsRepo.getSettings();
      const snapshot = snapshotOf(settings);

      // A failing source rejects the whole run: an unavailable pool is never an empty pool.
      const hasta = addDays(weekStart, 6);
      const [history, registerCounts, pool, absenceResult] = await Promise.all([
        salesRepo.loadSlotHistory({ bodegas: sede.bodegas, desde: addDays(weekStart, -HISTORY_LOOKBACK_DAYS), hasta }),
        salesRepo.loadRegisterCounts({ bodegas: sede.bodegas, hasta }),
        staffPort.getCashierPool(sedeId),
        absencesPort.getAbsences({ weekStart, blockingTypes: snapshot.blockingAbsenceTypes }),
      ]);

      // Without sales data the forecast degrades to noHistory days (zeros), it is never invented.
      const dataAsOf = history.dataAsOf ?? null;
      const forecast = forecastWeek({ weekStart, dataAsOf: dataAsOf ?? addDays(weekStart, -1), slots: history.slots, daily: history.daily });
      const productivity = dataAsOf ? computeProductivity(history.productivityRows, dataAsOf) : null;
      const week = assembleWeek({ weekStart, forecast, productivity, settings: snapshot, pool, absences: absenceResult.absences });

      const venta = new Map(forecast.days.flatMap((d) => d.slots.map((s) => [`${d.fecha}|${s.franja}`, s.venta])));
      const uncappedSlots = week.days.flatMap((d) =>
        d.slots.map((s) => ({
          fecha: d.fecha, franja: s.franja, forecastDocs: s.forecastDocs, forecastVenta: venta.get(`${d.fecha}|${s.franja}`) ?? 0,
          required: s.required, available: s.available, suggested: s.suggested, shortfall: s.shortfall, status: s.status,
        })),
      );
      // Physical registers cap simultaneous cashiers: suggested (hence final) is limited, required keeps the real demand.
      const registers = toRegisters(derivedRegisters(sede.bodegas, registerCounts), sede.registersOverride);
      const slots = capSlots(uncappedSlots, registers.effective);
      const capWarning = registersWarning({ registers: registers.effective, cappedSlots: countOverRegisters(uncappedSlots, registers.effective) });
      const flags = {
        noHistory: week.days.every((d) => d.noHistory),
        lowHistory: week.days.some((d) => d.lowHistory),
        noProductivity: week.flags.noProductivity,
      };
      const { settings: _settings, ...forecastInputs } = week.inputs;
      const inputs = {
        ...forecastInputs,
        productivity,
        poolSize: pool.length,
        registers,
        capacity: week.capacity,
        days: week.days.map(({ slots: _slots, ...meta }) => meta),
      };
      const run = { method: METHOD, settings: snapshot, inputs, flags, warnings: capWarning ? [...absenceResult.warnings, capWarning] : absenceResult.warnings, dataAsOf, createdBy: user.id, slots };

      // sugerido_save_run rejects a run without slots (no day had any history): answer from memory.
      if (slots.length === 0) {
        return composeWeek(sedeId, weekStart, { ...run, id: null, version: null, createdAt: now().toISOString() }, [], registers);
      }
      // Compose from the run THIS call saved: re-reading "latest" could return a concurrent recompute's run.
      const saved = await suggestionsRepo.saveRun({ sedeId, weekStart, ...run });
      const savedRun = await suggestionsRepo.getRunById(saved.id);
      if (!savedRun) throw new Error("Saved run could not be read back");
      return composeWeek(sedeId, weekStart, savedRun, await loadOverrides(sedeId, weekStart), registers);
    },

    /** Latest run + overrides, or an explicit empty state (200) when the week has no run yet. */
    async getWeek(_user, sedeId, weekStart) {
      assertWeekInRange(weekStart);
      return readWeek(await suggestionsRepo.getSede(sedeId), weekStart);
    },

    /** items: [{ fecha, franja, value }]; value null removes the override. */
    async saveOverrides(user, sedeId, weekStart, items) {
      assertWeekInRange(weekStart);
      const sede = await suggestionsRepo.getSede(sedeId);
      const run = await suggestionsRepo.getLatestRun(sedeId, weekStart);
      if (!run) throw createHttpError(409, "Calcula el sugerido de la semana antes de ajustarlo.", "NO_RUN");
      // Nobody can sit more cashiers than there are registers. Unknown registers never block.
      const registers = await currentRegisters(sede);
      if (registers.effective !== null) {
        const exceeded = items.filter((i) => i.value !== null && i.value > registers.effective).map(({ fecha, franja, value }) => ({ fecha, franja, value }));
        if (exceeded.length > 0) {
          const err = createHttpError(422, `La sede tiene ${registers.effective} puestos de pago: no puedes programar más cajeras a la vez.`, "REGISTERS_EXCEEDED");
          err.details = { registers: registers.effective, exceeded };
          throw err;
        }
      }
      // A slot the run has no suggestion for is still accepted (see orphanOverrideSlots): it records suggestedAtEdit null.
      const suggested = new Map(run.slots.map((s) => [`${s.fecha}|${s.franja}`, s.suggested]));
      await suggestionsRepo.applyOverrides({
        sedeId,
        userId: user.id,
        items: items.map(({ fecha, franja, value }) => ({ fecha, franja, value, suggestedAtEdit: suggested.get(`${fecha}|${franja}`) ?? null })),
      });
      return readWeek(sede, weekStart);
    },
  };
}
