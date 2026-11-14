import { spanMinutes, timeToMinutes } from "./weekPayload.js";

/**
 * Frozen caja/surtido split of a shift (migration 014). The client computes it when the leader publishes (it is exactly
 * what the leader saw); the backend stores it next to the shift so the public page can show it to the employee.
 *
 * Canonical form per shift: [{ role: "caja" | "surtido", from: "HH:MM", to: "HH:MM" }], ordered, on the 15-minute grid,
 * inside the shift. Gaps are allowed (lunch, break). "to" may be "24:00"; a shift that crosses midnight is handled by
 * measuring every time as minutes after the shift start.
 */

export const SEGMENT_ROLES = Object.freeze(["caja", "surtido"]);
export const SEGMENT_GRID_MINUTES = 15;
const DAY_MINUTES = 1440;

/**
 * Validates the segments of ONE shift. Returns the normalized list, or null when it is empty or does not fit the shift
 * (outside the shift, overlapping, off the grid, bad role): a missing breakdown is harmless, a failed publication is not.
 */
export function sanitizeShiftSegments(shift, segments) {
  if (!shift || shift.tipo !== "TRABAJO" || !shift.startTime || !shift.endTime) return null;
  if (!Array.isArray(segments) || segments.length === 0) return null;

  const start = timeToMinutes(shift.startTime);
  const end = start + spanMinutes(shift.startTime, shift.endTime);

  let cursor = start;
  const out = [];
  for (const seg of segments) {
    if (!SEGMENT_ROLES.includes(seg?.role)) return null;
    let from;
    let to;
    try {
      from = timeToMinutes(seg.from);
      to = timeToMinutes(seg.to, { allow24: true });
    } catch {
      return null;
    }
    if (from < start) from += DAY_MINUTES;
    while (to <= from) to += DAY_MINUTES;
    if (from % SEGMENT_GRID_MINUTES !== 0 || to % SEGMENT_GRID_MINUTES !== 0) return null;
    if (from < cursor || to > end) return null;
    cursor = to;
    out.push({ role: seg.role, from: seg.from, to: seg.to });
  }
  return out;
}

/**
 * Matches the client's `[{ cedula, fecha, segments }]` against the shifts that are really stored/sent and keeps only the
 * valid ones. `shifts` are camelCase rows ({ cedula, fecha, tipo, startTime, endTime }). Returns
 * `{ items, dropped }` where items are ready for the RPC (`[{ cedula, fecha, segments }]`).
 */
export function sanitizeSegmentsForShifts(shifts, input) {
  if (!Array.isArray(input) || input.length === 0) return { items: [], dropped: 0 };
  const byKey = new Map(shifts.map((s) => [`${s.cedula}|${s.fecha}`, s]));
  const seen = new Set();
  const items = [];
  let dropped = 0;
  for (const entry of input) {
    const key = `${entry?.cedula}|${entry?.fecha}`;
    const clean = byKey.has(key) && !seen.has(key) ? sanitizeShiftSegments(byKey.get(key), entry.segments) : null;
    if (!clean) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    items.push({ cedula: entry.cedula, fecha: entry.fecha, segments: clean });
  }
  return { items, dropped };
}
