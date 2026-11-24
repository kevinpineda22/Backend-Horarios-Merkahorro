import { normalizeCedula } from "../../shared/cedula.js";
import { createHttpError } from "../../shared/http/HttpError.js";
import { addDays, bogotaToday, weekDates } from "./domain/dates.js";
import { computeHeadcount } from "./domain/headcount.js";
import { computeProductivity, PRODUCTIVITY_WINDOW_DAYS } from "./domain/productivity.js";
import { computeAccuracy } from "./domain/accuracy.js";
import { atRegister, coverageByKey, onlyPeople } from "./domain/shiftCoverage.js";

/**
 * Accuracy ("asertividad") of a published week: what the week really needed vs what the system suggested and what
 * was published. Read-only: it never writes to Supabase nor to the sales database.
 *
 * Response of getAccuracy(sedeId, weekStart):
 * {
 *   status: "OK" | "INCOMPLETE" | "NOT_CLOSED" | "NO_SNAPSHOT",
 *     NOT_CLOSED  the week has not ended yet (Bogota date <= Sunday): nothing is measurable
 *     NO_SNAPSHOT the week was never published with a recommendation
 *     INCOMPLETE  sales data stops before Sunday (sync lags ~2 days): answered with dataAsOf, no metrics
 *   weekStart, weekEnd,            // Monday / Sunday, YYYY-MM-DD
 *   dataAsOf,                      // latest day with sales data (null when none / not queried); may be after weekEnd
 *                                  // when Sunday itself has no sales but later days do
 *   systemAvailable,               // false when the run behind the snapshot could not be found
 *   productivitySource,            // "run" (frozen in the run) | "reconstructed" (rebuilt from sales, run missing) | null
 *   snapshot: { id, publishedAt, runVersion } | null,
 *   leaderSource,                  // "saved" (shifts of the published schedule, later edits included) | "snapshot" | null
 *   stockersKnown,                 // false when the directory was not available: every person counts at the register
 *   // see domain/accuracy.js for the metric fields
 *   summary: { system, published, shifts: { suggested, leader }, docs, sales: { venta, docs } } | null,
 *   days: [{ fecha, system, published, docs, hours: [{ hour, needed, system, published }] }]
 * }
 * "shifts" grades real shifts (lunch excluded, capped by the registers) against the need: the ones the system built and
 * the ones the leader finally left published. A cajero-surtidor counts at the register only while one is short.
 * "needed" = real documents per franja -> computeHeadcount with the productivity and settings frozen in the run,
 * capped by the registers of the snapshot. "system" = run `required` (the pure forecast-driven demand, before pool
 * availability and planner overrides) capped the same way; a slot whose `required` is null is left out of the system
 * metrics, never counted as 0. "published" = the snapshot's `final`. Error 409 PRODUCTIVITY_UNAVAILABLE when no productivity can be determined.
 */
export function createAccuracyService({ suggestionsRepo, settingsRepo, salesRepo, snapshotsRepo, shiftsPort = null, staffPort = null, logger = console, now = () => new Date() }) {
  const base = (weekStart, over) => ({
    status: "OK", weekStart, weekEnd: addDays(weekStart, 6), dataAsOf: null, systemAvailable: false, productivitySource: null, leaderSource: null, stockersKnown: false,
    snapshot: null, summary: null, days: [], ...over,
  });

  const isCount = (n) => Number.isInteger(n) && n > 0;

  const capFor = (registers) => (n) => (isCount(registers) ? Math.min(n, registers) : n);

  /** Needed cashiers per "fecha|franja" for the real docs of the week. */
  function neededByKey(weekSlots, productivity, settings, registers) {
    const capped = capFor(registers);
    const out = new Map();
    for (const [fecha, byFranja] of Object.entries(weekSlots)) {
      const slots = Object.entries(byFranja).map(([franja, v]) => ({ franja, docs: v.docs }));
      for (const r of computeHeadcount({ slots, productivity, settings })) {
        const required = r.required ?? 0;
        out.set(`${fecha}|${r.franja}`, capped(required));
      }
    }
    return out;
  }

  /** The shifts the leader finally left published: the saved ones, else the copy frozen when publishing. */
  async function leaderRows(sedeId, weekStart, snap) {
    const saved = shiftsPort ? await shiftsPort.listPublishedCashierShifts(sedeId, weekStart) : null;
    if (saved?.length) return { rows: saved, source: "saved" };
    const frozen = onlyPeople(snap.published ?? [], snap.suggested?.cedulas);
    return frozen.length ? { rows: frozen, source: "snapshot" } : { rows: null, source: null };
  }

  /** Cedulas of the cajero-surtidor, null when the directory cannot answer (an outage must not hide the whole screen). */
  async function stockers() {
    if (!staffPort?.listStockerCedulas) return null;
    try {
      return await staffPort.listStockerCedulas();
    } catch (err) {
      logger?.warn?.("[accuracy] stockers unknown", { message: err?.message });
      return null;
    }
  }

  /** (key, need) -> cashiers at the registers with these shifts; null without rows. */
  function registerCoverage(rows, stockerCedulas) {
    if (!rows?.length) return null;
    const isStocker = (r) => stockerCedulas?.has(normalizeCedula(r.cedula)) ?? false;
    const cajeras = coverageByKey(rows.filter((r) => !isStocker(r)));
    const flexible = coverageByKey(rows.filter(isStocker));
    return { keys: [...new Set([...cajeras.keys(), ...flexible.keys()])], at: (key, need) => atRegister(cajeras.get(key) ?? 0, flexible.get(key) ?? 0, need) };
  }

  return {
    async getAccuracy(sedeId, weekStart) {
      if (!snapshotsRepo) throw new Error("getAccuracy requires snapshotsRepo");
      const weekEnd = addDays(weekStart, 6);
      const sede = await suggestionsRepo.getSede(sedeId); // unmapped / inactive -> 404 before any source

      if (bogotaToday(now()) <= weekEnd) return base(weekStart, { status: "NOT_CLOSED" });

      // Accuracy compares the cashier recommendation only (other teams publish without one).
      const snap = await snapshotsRepo.findLatestByWeek({ sedeId, weekStart, teamKey: "CAJEROS" });
      const rec = snap?.recommendation;
      if (!snap || !rec || !Array.isArray(rec.slots) || rec.slots.length === 0) return base(weekStart, { status: "NO_SNAPSHOT" });
      const snapshot = { id: snap.id, publishedAt: snap.publishedAt, runVersion: rec.runVersion ?? null };

      // The sales pool has ONE connection: queries go one after the other.
      const history = await salesRepo.loadSlotHistory({ bodegas: sede.bodegas, desde: weekStart, hasta: weekEnd });
      const dataAsOf = history.dataAsOf ?? null;
      let horizon = dataAsOf;
      if (!dataAsOf || dataAsOf < weekEnd) {
        // Sunday may legitimately have no sales: the week is complete anyway when sales exist after it.
        const after = await salesRepo.loadSlotHistory({ bodegas: sede.bodegas, desde: addDays(weekEnd, 1), hasta: addDays(weekEnd, 7) });
        if (!after.dataAsOf || after.dataAsOf <= weekEnd) return base(weekStart, { status: "INCOMPLETE", dataAsOf, snapshot });
        horizon = after.dataAsOf;
      }

      const run = Number.isInteger(rec.runVersion) ? await suggestionsRepo.getRunByVersion(sedeId, weekStart, rec.runVersion) : null;

      let productivity;
      let settings;
      let productivitySource;
      if (run) {
        productivity = run.inputs?.productivity ?? null;
        settings = run.settings;
        productivitySource = "run";
      } else {
        // The run is gone: rebuild the productivity from the sales window the run used (same rule) and take today's settings.
        settings = await settingsRepo.getSettings();
        productivitySource = "reconstructed";
        productivity = null;
        if (rec.dataAsOf) {
          const past = await salesRepo.loadSlotHistory({ bodegas: sede.bodegas, desde: addDays(rec.dataAsOf, -PRODUCTIVITY_WINDOW_DAYS), hasta: rec.dataAsOf });
          productivity = past.dataAsOf ? computeProductivity(past.productivityRows, past.dataAsOf) : null;
        }
      }
      if (!(productivity > 0)) {
        throw createHttpError(409, "No hay productividad congelada para medir esta semana.", "PRODUCTIVITY_UNAVAILABLE");
      }

      const needed = neededByKey(history.slots, productivity, settings, rec.registers ?? null);
      const published = new Map(rec.slots.map((s) => [`${s.fecha}|${s.franja}`, s.final]));
      // required (not suggested): suggested is limited by the cashier pool, which is capacity, not forecast accuracy.
      const cap = capFor(rec.registers ?? null);
      const system = new Map((run?.slots ?? []).map((s) => [`${s.fecha}|${s.franja}`, s.required === null || s.required === undefined ? null : cap(s.required)]));
      const forecast = new Map((run?.slots ?? []).map((s) => [`${s.fecha}|${s.franja}`, s.forecastDocs]));

      const leader = await leaderRows(sedeId, weekStart, snap);
      const stockerCedulas = await stockers();
      const leaderAt = registerCoverage(leader.rows, stockerCedulas);
      const suggestedRows = snap.suggested?.shifts;
      const suggestedAt = registerCoverage(Array.isArray(suggestedRows) ? suggestedRows : null, stockerCedulas);
      const present = (coverage, key) => (coverage ? cap(coverage.at(key, needed.get(key) ?? 0)) : null);

      const week = new Set(weekDates(weekStart));
      const keys = new Set([...needed.keys(), ...published.keys(), ...system.keys(), ...forecast.keys(), ...(suggestedAt?.keys ?? []), ...(leaderAt?.keys ?? [])]);
      const rows = [];
      for (const key of keys) {
        const [fecha, franja] = key.split("|");
        if (!week.has(fecha)) continue;
        rows.push({
          fecha, franja,
          needed: needed.get(key) ?? 0,
          system: run ? (system.has(key) ? system.get(key) : 0) : null,
          published: published.get(key) ?? 0,
          suggestedShifts: present(suggestedAt, key),
          leaderShifts: present(leaderAt, key),
          forecastDocs: forecast.get(key) ?? 0,
          actualDocs: history.slots[fecha]?.[franja]?.docs ?? 0,
        });
      }

      const accuracy = computeAccuracy(rows);
      // Without the run there is no forecast to grade: docs metrics would compare zeros with real demand.
      const sold = [...week].flatMap((fecha) => Object.values(history.slots[fecha] ?? {}));
      const sales = { venta: Math.round(sold.reduce((sum, s) => sum + (s.venta ?? 0), 0)), docs: sold.reduce((sum, s) => sum + (s.docs ?? 0), 0) };
      const summary = { ...accuracy.summary, sales, ...(run ? {} : { docs: null }) };
      const days = run ? accuracy.days : accuracy.days.map((d) => ({ ...d, docs: null }));
      return base(weekStart, { dataAsOf: horizon, systemAvailable: Boolean(run), productivitySource, leaderSource: leader.source, stockersKnown: stockerCedulas !== null, snapshot, summary, days });
    },
  };
}
