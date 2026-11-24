import { SLOT_MINUTES } from "./dates.js";
import { wape } from "./backtest.js";

/**
 * Accuracy ("asertividad") of the staffing suggestion against what the week actually needed. Pure.
 *
 * Input rows, one per (fecha, franja) of the week (15-minute slots):
 *   { fecha, franja, needed, system, published, forecastDocs, actualDocs }
 *     needed     cashiers the REAL demand required (null is not allowed: the caller computes it for every row)
 *     system     cashiers the system suggested before planner overrides (null when the run is unavailable)
 *     published  cashiers shown to the leader at publication (the snapshot's `final`)
 *     suggestedShifts / leaderShifts  cashiers present with the shifts the system built / the leader left published
 *                (optional; null or missing = not measured)
 *     forecastDocs / actualDocs  documents forecast vs documents really issued
 *
 * Metrics of one staffing series (system or published) against `needed`:
 *   overHours / underHours  cashier-hours of over / under staffing (sum of the slot gap * 0.25 h)
 *   neededHours / hours     cashier-hours needed / staffed
 *   missingSlots            slots left out because the series has no value there
 *   openSlots               slots that are open: forecastDocs > 0 or actualDocs > 0
 *   exactRate / withinOneRate  share (0..1) of open slots with gap 0 / |gap| <= 1; null without open slots
 *   wape / bias             over cashier-hours: sum|x-needed| / sum needed, (sum x - sum needed) / sum needed;
 *                           null when nothing was needed
 * Docs metrics: { wape, bias, forecast, actual } of forecastDocs vs actualDocs.
 */

const HOURS_PER_SLOT = SLOT_MINUTES / 60;
const SLOTS_PER_HOUR = 60 / SLOT_MINUTES;

const round = (n, digits) => (n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits);
const round2 = (n) => round(n, 2);
const round4 = (n) => round(n, 4);

const SHIFT_SERIES = ["suggestedShifts", "leaderShifts"];
const isMeasured = (r, key) => r[key] !== null && r[key] !== undefined;
// { suggested, leader }: metrics of the shifts themselves, null each when that version is not known.
const shiftsMetrics = (rows) => ({ suggested: seriesMetrics(rows, "suggestedShifts"), leader: seriesMetrics(rows, "leaderShifts") });

const isOpen = (r) => r.forecastDocs > 0 || r.actualDocs > 0;

/** Metrics of one series (`key` = "system" | "published") over rows; null when the series has no value at all. */
export function seriesMetrics(allRows, key) {
  // A row without a value for this series (e.g. a slot whose required is unknown) is missing, not zero.
  const rows = allRows.filter((r) => r[key] !== null && r[key] !== undefined);
  if (rows.length === 0) return null;
  const staffed = (r) => r[key];
  let over = 0;
  let under = 0;
  let needed = 0;
  let total = 0;
  let absGap = 0;
  for (const r of rows) {
    const x = staffed(r);
    over += Math.max(0, x - r.needed);
    under += Math.max(0, r.needed - x);
    absGap += Math.abs(x - r.needed);
    needed += r.needed;
    total += x;
  }
  const open = rows.filter(isOpen);
  const share = (pred) => (open.length > 0 ? open.filter(pred).length / open.length : null);
  return {
    overHours: round2(over * HOURS_PER_SLOT),
    underHours: round2(under * HOURS_PER_SLOT),
    neededHours: round2(needed * HOURS_PER_SLOT),
    hours: round2(total * HOURS_PER_SLOT),
    openSlots: open.length,
    missingSlots: allRows.length - rows.length,
    exactRate: round4(share((r) => staffed(r) === r.needed)),
    withinOneRate: round4(share((r) => Math.abs(staffed(r) - r.needed) <= 1)),
    wape: needed > 0 ? round4(absGap / needed) : null,
    bias: needed > 0 ? round4((total - needed) / needed) : null,
  };
}

/** Forecast vs actual documents. */
export function docsMetrics(rows) {
  const pairs = rows.map((r) => ({ forecast: r.forecastDocs, actual: r.actualDocs }));
  const actual = pairs.reduce((s, p) => s + p.actual, 0);
  const forecast = pairs.reduce((s, p) => s + p.forecast, 0);
  return {
    wape: round4(wape(pairs)),
    bias: actual > 0 ? round4((forecast - actual) / actual) : null,
    forecast: round2(forecast),
    actual: round2(actual),
  };
}

/** 15-minute rows -> one entry per hour with the average cashiers (sum of slots / 4) of each series. */
export function hourlySeries(rows) {
  const byHour = new Map();
  for (const r of rows) {
    const hour = Number(r.franja.slice(0, 2));
    const h = byHour.get(hour) ?? { needed: 0, system: 0, published: 0, hasSystem: false, suggestedShifts: null, leaderShifts: null };
    h.needed += r.needed;
    h.published += r.published ?? 0;
    for (const key of SHIFT_SERIES) if (isMeasured(r, key)) h[key] = (h[key] ?? 0) + r[key];
    if (r.system !== null && r.system !== undefined) {
      h.system += r.system;
      h.hasSystem = true;
    }
    byHour.set(hour, h);
  }
  return [...byHour.keys()]
    .sort((a, b) => a - b)
    .map((hour) => {
      const h = byHour.get(hour);
      return {
        hour,
        needed: round2(h.needed / SLOTS_PER_HOUR),
        system: h.hasSystem ? round2(h.system / SLOTS_PER_HOUR) : null,
        published: round2(h.published / SLOTS_PER_HOUR),
        ...Object.fromEntries(SHIFT_SERIES.filter((key) => h[key] !== null).map((key) => [key, round2(h[key] / SLOTS_PER_HOUR)])),
      };
    });
}

const byFechaFranja = (a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.franja < b.franja ? -1 : a.franja > b.franja ? 1 : 0);

/**
 * Week summary and per-day breakdown. `summary.system` is null when no row carries a system value.
 * @returns {{ summary: { system, published, docs }, days: Array<{ fecha, system, published, docs, hours }> }}
 */
export function computeAccuracy(rows) {
  const sorted = [...rows].sort(byFechaFranja);
  const byDay = new Map();
  for (const r of sorted) {
    if (!byDay.has(r.fecha)) byDay.set(r.fecha, []);
    byDay.get(r.fecha).push(r);
  }
  return {
    summary: { system: seriesMetrics(sorted, "system"), published: seriesMetrics(sorted, "published"), shifts: shiftsMetrics(sorted), docs: docsMetrics(sorted) },
    days: [...byDay.entries()].map(([fecha, dayRows]) => ({
      fecha,
      system: seriesMetrics(dayRows, "system"),
      published: seriesMetrics(dayRows, "published"),
      shifts: shiftsMetrics(dayRows),
      docs: docsMetrics(dayRows),
      hours: hourlySeries(dayRows),
    })),
  };
}
