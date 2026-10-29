import { addDays } from "./dates.js";

export const PRODUCTIVITY_WINDOW_DAYS = 56; // 8 weeks
const TOP_SHARE = 0.2; // busiest 20% of slots
const SLOTS_PER_HOUR = 4;

const round4 = (n) => Math.round(n * 1e4) / 1e4;

/**
 * Docs per cashier-hour for one sede.
 * rows: [{ fecha, franja, docs, cajeras }] (cajeras = distinct cashiers in the slot).
 * Only rows in [dataAsOf - 56d, dataAsOf) count; the last day may be partial.
 * Returns the docs-weighted mean rate of the busiest 20% slots, or null when no data.
 */
export function computeProductivity(rows, dataAsOf) {
  const from = addDays(dataAsOf, -PRODUCTIVITY_WINDOW_DAYS);
  const slots = [];
  for (const r of rows) {
    if (!Number.isFinite(r.docs) || !Number.isFinite(r.cajeras)) {
      throw new Error("Productivity rows require finite docs and cajeras");
    }
    if (r.fecha < from || r.fecha >= dataAsOf) continue;
    if (r.docs <= 0 || r.cajeras <= 0) continue;
    slots.push({ docs: r.docs, rate: (r.docs * SLOTS_PER_HOUR) / r.cajeras });
  }
  if (slots.length === 0) return null;

  slots.sort((a, b) => b.docs - a.docs);
  const top = slots.slice(0, Math.ceil(slots.length * TOP_SHARE));
  const weight = top.reduce((s, x) => s + x.docs, 0);
  return round4(top.reduce((s, x) => s + x.rate * x.docs, 0) / weight);
}
