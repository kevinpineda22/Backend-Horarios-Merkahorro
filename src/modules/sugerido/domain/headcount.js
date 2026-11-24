import { SLOTS_PER_DAY, slotIndex } from "./dates.js";

const SLOTS_PER_HOUR = 4;
const EPSILON = 1e-9; // guards ceil against float noise (34 / 8.5 must be exactly 4)

const round4 = (n) => Math.round(n * 1e4) / 1e4;

function assertFinite(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
}

// After closing time only stray receipts are left. The trailing slots under this share of the day's median slot are not
// opening hours: nobody is scheduled for them (a single late receipt would otherwise keep a cashier until 22:30).
export const STRAY_TAIL_SHARE = 0.1;

/** Index of the last slot with real activity, -1 without sales. Only the END of the day is trimmed, never a quiet slot inside it. */
export function lastBusyIndex(docsAt) {
  const open = docsAt.filter((docs) => docs > 0).sort((a, b) => a - b);
  if (open.length === 0) return -1;
  const floor = open[Math.floor(open.length / 2)] * STRAY_TAIL_SHARE;
  return docsAt.findLastIndex((docs) => docs > 0 && docs >= floor);
}

/**
 * Required cashiers per forecast slot.
 * slots: [{ franja, docs }] (docs per 15-min slot). A slot with docs <= 0, or in the stray
 * tail after closing (lastBusyIndex), is closed: 0 cashiers. The tail still smooths the slot before it.
 * required = max(minCashiers, ceil(smoothedDocsPerHour / (productivity * utilization)))
 * Smoothing is a centered moving average over the slot and its neighbours, using only
 * neighbours that exist within the day and are open (docs > 0): the window shrinks at the
 * day edges and next to closed slots instead of being diluted by phantom zeros.
 */
export function computeHeadcount({ slots, productivity, settings }) {
  const { utilization, minCashiers } = settings;
  assertFinite("utilization", utilization);
  assertFinite("minCashiers", minCashiers);
  if (utilization <= 0) throw new Error("utilization must be greater than 0");
  if (productivity !== null) {
    assertFinite("productivity", productivity);
    if (productivity < 0) throw new Error("productivity must not be negative");
  }

  const docsAt = new Array(SLOTS_PER_DAY).fill(0);
  for (const s of slots) docsAt[slotIndex(s.franja)] = s.docs;

  const lastBusy = lastBusyIndex(docsAt);
  const hasProductivity = productivity !== null && productivity > 0;
  return slots.map((s) => {
    const i = slotIndex(s.franja);
    const window = [docsAt[i]];
    for (const j of [i - 1, i + 1]) if (j >= 0 && j < SLOTS_PER_DAY && docsAt[j] > 0) window.push(docsAt[j]);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const smoothedDocsPerHour = round4(mean * SLOTS_PER_HOUR);
    const base = { franja: s.franja, forecastDocs: s.docs, smoothedDocsPerHour };

    if (!hasProductivity) return { ...base, required: null, status: "unknown" };
    if (s.docs <= 0 || i > lastBusy) return { ...base, required: 0, status: "closed" };
    const needed = Math.ceil(smoothedDocsPerHour / (productivity * utilization) - EPSILON);
    return { ...base, required: Math.max(minCashiers, needed), status: "ok" };
  });
}
