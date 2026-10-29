import { dayType } from "./calendar.js";
import { addDays, isoDow, weekDates } from "./dates.js";
import { forecastWeek } from "./forecast.js";

/** { [fecha]: { [HH:MM]: { docs } } } -> [{ fecha, hour, docs }] with the 15-minute slots summed per hour. */
export function aggregateToHour(slots) {
  const out = [];
  for (const fecha of Object.keys(slots).sort()) {
    const byHour = new Map();
    for (const [franja, v] of Object.entries(slots[fecha])) {
      const hour = Number(franja.slice(0, 2));
      byHour.set(hour, (byHour.get(hour) ?? 0) + (v?.docs ?? 0));
    }
    for (const hour of [...byHour.keys()].sort((a, b) => a - b)) out.push({ fecha, hour, docs: byHour.get(hour) });
  }
  return out;
}

const sum = (rows, field) => rows.reduce((s, r) => s + r[field], 0);

/** Weighted absolute percentage error: sum|F-A| / sum A. null when there is no actual demand. */
export function wape(pairs) {
  const actual = pairs.reduce((s, p) => s + p.actual, 0);
  if (!(actual > 0)) return null;
  return pairs.reduce((s, p) => s + Math.abs(p.forecast - p.actual), 0) / actual;
}

function stats(rows) {
  const actual = sum(rows, "actual");
  const forecast = sum(rows, "forecast");
  return {
    wape: wape(rows),
    bias: actual > 0 ? (forecast - actual) / actual : null,
    n: rows.length,
    actual,
    forecast,
  };
}

/** Overall stats plus one ordered list of { group, ...stats } per grouping key. */
export function summarize(rows, keys) {
  const by = {};
  for (const key of keys) {
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r[key])) groups.set(r[key], []);
      groups.get(r[key]).push(r);
    }
    by[key] = [...groups.keys()]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((group) => ({ group, ...stats(groups.get(group)) }));
  }
  return { overall: stats(rows), by };
}

/**
 * Hourly forecast vs actual for one week, as the service would have produced it: only history with
 * fecha < weekStart reaches forecastWeek, and dataAsOf is the latest day with data before the week
 * (the service treats that last day as partial, and so does the model).
 * history: { slots, daily } for a range that may include the target week (its actuals) and later days.
 */
export function backtestWeek({ history, weekStart }) {
  const slots = {};
  const daily = {};
  let dataAsOf = null;
  for (const fecha of Object.keys(history.daily)) {
    if (fecha >= weekStart) continue;
    daily[fecha] = history.daily[fecha];
    if (dataAsOf === null || fecha > dataAsOf) dataAsOf = fecha;
  }
  for (const fecha of Object.keys(history.slots)) if (fecha < weekStart) slots[fecha] = history.slots[fecha];

  const forecast = forecastWeek({ weekStart, dataAsOf: dataAsOf ?? addDays(weekStart, -1), slots, daily });

  const cells = new Map(); // `${fecha}|${hour}` -> { forecast, actual }
  const cell = (fecha, hour) => {
    const k = `${fecha}|${hour}`;
    if (!cells.has(k)) cells.set(k, { fecha, hour, forecast: 0, actual: 0 });
    return cells.get(k);
  };
  for (const d of forecast.days) {
    for (const s of d.slots) cell(d.fecha, Number(s.franja.slice(0, 2))).forecast += s.docs;
  }
  const inWeek = Object.fromEntries(weekDates(weekStart).filter((f) => history.slots[f]).map((f) => [f, history.slots[f]]));
  for (const a of aggregateToHour(inWeek)) cell(a.fecha, a.hour).actual += a.docs;

  return [...cells.values()]
    .sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : x.hour - y.hour))
    .map((c) => ({ ...c, week: weekStart, weekday: isoDow(c.fecha), dayType: dayType(c.fecha) }));
}
