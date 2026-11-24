import { SLOTS_PER_DAY, SLOT_MINUTES } from "./dates.js";

const DEFAULT_LUNCH_OFFSET_MINUTES = 240; // same default as the scheduler: the lunch starts 4 h after the shift
const HALF_HOUR = 30;

const minutesOf = (time) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** A shift row of the database (snake_case, HH:MM:SS) or of a publish snapshot (camelCase) -> one shape. */
const normalize = (r) => ({
  fecha: r.fecha,
  tipo: r.tipo,
  start: minutesOf(r.startTime ?? r.start_time),
  end: minutesOf(r.endTime ?? r.end_time),
  lunch: minutesOf(r.lunchStart ?? r.lunch_start),
  pause: r.breakMinutes ?? r.break_minutes ?? null,
});

const defaultBreak = (span) => (span >= 360 ? 60 : 0);

/**
 * Cashiers present per "fecha|franja" (15 minutes) of a list of shifts, lunch excluded. A slot counts when the shift covers
 * it whole. A missing break follows the scheduler rule (1 h from 6 h on). A shift past midnight counts until 24:00 of its day.
 * @returns {Map<string, number>} only the slots with somebody
 */
export function coverageByKey(rows) {
  const out = new Map();
  for (const raw of rows) {
    const s = normalize(raw);
    if (s.tipo !== "TRABAJO" || s.start === null || s.end === null) continue;
    const end = s.end <= s.start ? SLOTS_PER_DAY * SLOT_MINUTES : s.end;
    const pause = s.pause ?? defaultBreak(end - s.start);
    const lunchFrom = s.lunch ?? Math.round((s.start + DEFAULT_LUNCH_OFFSET_MINUTES) / HALF_HOUR) * HALF_HOUR;
    for (let slot = Math.ceil(s.start / SLOT_MINUTES); (slot + 1) * SLOT_MINUTES <= end; slot += 1) {
      const from = slot * SLOT_MINUTES;
      if (pause > 0 && from + SLOT_MINUTES > lunchFrom && from < lunchFrom + pause) continue;
      const key = `${s.fecha}|${String(Math.floor(from / 60)).padStart(2, "0")}:${String(from % 60).padStart(2, "0")}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

/** Rows of the given people only; every row when there is no list. */
export const onlyPeople = (rows, cedulas) => {
  if (!Array.isArray(cedulas)) return rows;
  const team = new Set(cedulas.map(String));
  return rows.filter((r) => team.has(String(r.cedula)));
};
