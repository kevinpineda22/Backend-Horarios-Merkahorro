import { SLOTS_PER_DAY, slotIndex } from "./dates.js";

const SLOTS_PER_HOUR = 4;
const EPSILON = 1e-9; // guards ceil against float noise (34 / 8.5 must be exactly 4)

const round4 = (n) => Math.round(n * 1e4) / 1e4;

function assertFinite(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
}

/**
 * Required cashiers per forecast slot.
 * slots: [{ franja, docs }] (docs per 15-min slot). A slot with docs <= 0 is closed.
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

  const hasProductivity = productivity !== null && productivity > 0;
  return slots.map((s) => {
    const i = slotIndex(s.franja);
    const window = [docsAt[i]];
    for (const j of [i - 1, i + 1]) if (j >= 0 && j < SLOTS_PER_DAY && docsAt[j] > 0) window.push(docsAt[j]);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const smoothedDocsPerHour = round4(mean * SLOTS_PER_HOUR);
    const base = { franja: s.franja, forecastDocs: s.docs, smoothedDocsPerHour };

    if (!hasProductivity) return { ...base, required: null, status: "unknown" };
    if (s.docs <= 0) return { ...base, required: 0, status: "closed" };
    const needed = Math.ceil(smoothedDocsPerHour / (productivity * utilization) - EPSILON);
    return { ...base, required: Math.max(minCashiers, needed), status: "ok" };
  });
}
