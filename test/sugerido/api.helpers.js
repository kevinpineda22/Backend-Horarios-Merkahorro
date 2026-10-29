import { addDays, diffDays } from "../../src/modules/sugerido/domain/dates.js";
import { ABSENCE_TYPES } from "../../src/modules/sugerido/domain/absences.js";
import { createHttpError } from "../../src/shared/http/HttpError.js";

// Target week has no Colombian holiday; the clock sits 1 day after the last sales day.
export const WEEK = "2026-11-23";
export const SETTINGS = {
  ordinaryWeeklyHours: 42, overtimeWeeklyHours: 12, dailyMaxHours: 10, utilization: 0.85,
  maxWorkingDaysPerWeek: 6, minCashiers: 1, staleAfterDays: 1, blockingAbsenceTypes: [...ABSENCE_TYPES],
  updatedBy: "u-admin", updatedAt: "2026-10-28T00:00:00Z",
};
export const POOL = ["1001001", "1001002", "1001003", "1001004", "1001005"];
export const SLOTS_PER_OPEN_DAY = 49; // 08:00..20:00

const FRANJAS = Array.from({ length: SLOTS_PER_OPEN_DAY }, (_, i) => {
  const m = 8 * 60 + i * 15;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
});

/** Flat history: every day in [from, to] trades 20 docs per slot with 2 cashiers (40 docs/cashier-hour). */
export function buildHistory({ from = "2026-08-01", to = "2026-11-20", dataAsOf = to, docs = 20, cajeras = 2, withProductivity = true } = {}) {
  const slots = {}, daily = {}, productivityRows = [];
  for (let d = from; diffDays(to, d) >= 0; d = addDays(d, 1)) {
    slots[d] = Object.fromEntries(FRANJAS.map((f) => [f, { docs, venta: docs * 1000 }]));
    daily[d] = docs * FRANJAS.length;
    if (withProductivity) for (const franja of FRANJAS) productivityRows.push({ fecha: d, franja, docs, cajeras });
  }
  return { dataAsOf, slots, daily, productivityRows };
}

/** In-memory suggestions repo (same contract as createSuggestionsRepo) with call logs. */
export function fakeSuggestions(sedes = [
  { sedeId: "s1", nombre: "Centro", bodegas: ["B1", "B2"], activo: true },
  { sedeId: "s2", nombre: "Norte", bodegas: ["B3"], activo: true },
  { sedeId: "s3", nombre: "Cerrada", bodegas: ["B4"], activo: false },
]) {
  const runs = [], overrides = new Map(), calls = { saveRun: [], applyOverrides: [] };
  return {
    calls, runs, overrides,
    async listSedes() { return sedes.filter((s) => s.activo); },
    async getSede(id) {
      const s = sedes.find((x) => x.sedeId === id && x.activo);
      if (!s) throw createHttpError(404, "La sede no está configurada para el sugerido.", "SEDE_NOT_MAPPED");
      return s;
    },
    async saveRun(run) {
      calls.saveRun.push(structuredClone(run));
      const version = runs.filter((r) => r.sedeId === run.sedeId && r.weekStart === run.weekStart).length + 1;
      const id = `run-${runs.length + 1}`;
      runs.push({ ...structuredClone(run), id, version, createdAt: "2026-11-21T15:00:00Z" });
      return { id, version };
    },
    async getRunById(id) {
      const found = runs.find((r) => r.id === id);
      return found ? structuredClone(found) : null;
    },
    async getLatestRun(sedeId, weekStart) {
      const found = runs.filter((r) => r.sedeId === sedeId && r.weekStart === weekStart).at(-1);
      return found ? structuredClone(found) : null;
    },
    async getOverrides(sedeId, { desde, hasta }) {
      return [...overrides.values()].filter((o) => o.sedeId === sedeId && o.fecha >= desde && o.fecha <= hasta).map(({ sedeId: _s, ...o }) => o);
    },
    async applyOverrides({ sedeId, userId, items }) {
      calls.applyOverrides.push(structuredClone({ sedeId, userId, items }));
      let upserted = 0, deleted = 0;
      for (const i of items) {
        const key = `${sedeId}|${i.fecha}|${i.franja}`;
        if (i.value === null) deleted += overrides.delete(key) ? 1 : 0;
        else {
          overrides.set(key, { sedeId, fecha: i.fecha, franja: i.franja, headcount: i.value, suggestedAtEdit: i.suggestedAtEdit ?? null, reason: i.reason ?? null, updatedBy: userId, updatedAt: "2026-11-21T15:00:00Z" });
          upserted += 1;
        }
      }
      return { upserted, deleted };
    },
  };
}

/** Full dependency set with spies. `state` fields can be mutated between calls. */
export function makeDeps({ history = buildHistory(), pool = POOL, absences = { absences: [], warnings: [] }, settings = SETTINGS, sedes } = {}) {
  const state = { history, pool, absences, settings, now: new Date("2026-11-21T15:00:00Z") };
  const calls = { sales: [], staff: [], absences: [], settings: 0 };
  const settle = (v) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  const suggestionsRepo = fakeSuggestions(sedes);
  const deps = {
    suggestionsRepo,
    settingsRepo: { async getSettings() { calls.settings += 1; return { ...state.settings }; } },
    salesRepo: { async loadSlotHistory(args) { calls.sales.push(args); return settle(state.history); } },
    staffPort: { async getCashierPool(sedeId) { calls.staff.push(sedeId); return settle(state.pool.map ? state.pool.map((cedula) => ({ cedula })) : state.pool); } },
    absencesPort: { async getAbsences(args) { calls.absences.push(args); return settle(state.absences); } },
    now: () => state.now,
  };
  return { deps, state, calls, repo: suggestionsRepo };
}

export const USER = { id: "u-planner" };
