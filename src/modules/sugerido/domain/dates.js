// Date-only math on 'YYYY-MM-DD' strings using UTC epoch days.
// Avoids local-midnight drift: Vercel runs in UTC while the business runs in America/Bogota.

const MS_PER_DAY = 86_400_000;
const BOGOTA_OFFSET_MS = 5 * 3_600_000; // America/Bogota is UTC-5 all year (no DST)
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const SLOT_MINUTES = 15;
export const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;

export function toEpochDay(fecha) {
  const m = DATE_RE.exec(String(fecha));
  if (!m) throw new Error(`Invalid date: ${fecha}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Round-trip check rejects overflow such as 2026-02-30.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new Error(`Invalid date: ${fecha}`);
  }
  return ms / MS_PER_DAY;
}

export function fromEpochDay(epochDay) {
  return new Date(epochDay * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(fecha, n) {
  return fromEpochDay(toEpochDay(fecha) + n);
}

/** a - b in whole days. */
export function diffDays(a, b) {
  return toEpochDay(a) - toEpochDay(b);
}

/** ISO weekday: Monday=1 .. Sunday=7 (epoch day 0 is a Thursday). */
export function isoDow(fecha) {
  return ((((toEpochDay(fecha) + 3) % 7) + 7) % 7) + 1;
}

export function mondayOf(fecha) {
  return addDays(fecha, -(isoDow(fecha) - 1));
}

export function weekDates(weekStart) {
  if (isoDow(weekStart) !== 1) throw new Error(`weekStart must be a Monday: ${weekStart}`);
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** Current calendar date in Bogota. The clock is injected for deterministic tests. */
export function bogotaToday(now = new Date()) {
  return new Date(now.getTime() - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'HH:MM' or 'HH:MM:SS' -> slot index 0..95. */
export function slotIndex(franja) {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(franja));
  const minutes = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  if (!Number.isInteger(minutes) || minutes >= 1440 || minutes % SLOT_MINUTES !== 0) {
    throw new Error(`Invalid slot: ${franja}`);
  }
  return minutes / SLOT_MINUTES;
}

export function slotLabel(index) {
  const minutes = index * SLOT_MINUTES;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function normalizeFranja(franja) {
  return slotLabel(slotIndex(franja));
}
