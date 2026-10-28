import { dayType, getHoliday, referenceDates } from "./calendar.js";
import { addDays, weekDates } from "./dates.js";

const TREND_WINDOW_DAYS = 28;
const YEAR_OFFSET_DAYS = 364; // 52 weeks keeps the same weekday
const TREND_MIN = 0.7;
const TREND_MAX = 1.3;
const REFERENCE_COUNT = 4;
const PEAK_SLOTS = 3;

const round4 = (n) => Math.round(n * 1e4) / 1e4;

export function clampTrend(ratio) {
  if (!Number.isFinite(ratio)) return 1;
  return Math.min(TREND_MAX, Math.max(TREND_MIN, ratio));
}

/** Docs of the last 28 days (strictly before dataAsOf) over the same 28 days a year earlier. */
export function computeTrend(daily, dataAsOf) {
  let recent = 0;
  let prior = 0;
  for (let i = 1; i <= TREND_WINDOW_DAYS; i += 1) {
    const d = addDays(dataAsOf, -i);
    recent += daily[d] ?? 0;
    prior += daily[addDays(d, -YEAR_OFFSET_DAYS)] ?? 0;
  }
  return prior > 0 ? clampTrend(recent / prior) : 1;
}

/**
 * Forecast one day.
 * slots: { [fecha]: { [HH:MM]: { docs, venta } } }   daily: { [fecha]: docs }
 * A = mean over reference dates of the same day type (missing slot = 0 on an open day).
 * B = same weekday 364 days back x trend. Blend = (A + B) / 2, or whichever exists.
 */
export function forecastDay({ fecha, dataAsOf, slots, daily, trendRatio = 1 }) {
  const isOpen = (d) => (daily[d] ?? 0) > 0;
  const refs = referenceDates(fecha, dataAsOf, { count: REFERENCE_COUNT, isOpen });

  // B only applies when the year-ago date is the same day type and already complete.
  const yearAgo = addDays(fecha, -YEAR_OFFSET_DAYS);
  const useB = yearAgo < dataAsOf && isOpen(yearAgo) && dayType(yearAgo) === dayType(fecha);

  const labels = new Set();
  for (const d of refs) Object.keys(slots[d] ?? {}).forEach((f) => labels.add(f));
  if (useB) Object.keys(slots[yearAgo] ?? {}).forEach((f) => labels.add(f));

  const hasA = refs.length > 0;
  const mean = (field, f) => refs.reduce((s, d) => s + (slots[d]?.[f]?.[field] ?? 0), 0) / refs.length;
  const out = [...labels].sort().map((franja) => {
    const value = (field) => {
      const a = hasA ? mean(field, franja) : null;
      const b = useB ? (slots[yearAgo]?.[franja]?.[field] ?? 0) * trendRatio : null;
      return round4(a !== null && b !== null ? (a + b) / 2 : (a ?? b));
    };
    return { franja, docs: value("docs"), venta: value("venta") };
  });

  const docs = round4(out.reduce((s, x) => s + x.docs, 0));
  const venta = round4(out.reduce((s, x) => s + x.venta, 0));
  const noHistory = !hasA && !useB;

  return {
    fecha,
    dayType: dayType(fecha),
    holidayName: getHoliday(fecha),
    noHistory,
    lowHistory: !noHistory && refs.length < 2,
    method: noHistory ? "none" : hasA && useB ? "blend" : hasA ? "sameDayType" : "yearAgo",
    slots: out,
    totals: {
      docs,
      venta,
      avgTicket: docs > 0 ? round4(venta / docs) : 0,
      peakSlots: [...out]
        .sort((x, y) => y.docs - x.docs || x.franja.localeCompare(y.franja))
        .slice(0, PEAK_SLOTS)
        .map((x) => x.franja),
    },
    inputs: { referenceDates: refs, samples: refs.length, yearAgoUsed: useB, yearAgoDate: useB ? yearAgo : null, trendRatio },
  };
}

export function forecastWeek({ weekStart, dataAsOf, slots, daily }) {
  const trendRatio = computeTrend(daily, dataAsOf);
  const days = weekDates(weekStart).map((fecha) => forecastDay({ fecha, dataAsOf, slots, daily, trendRatio }));
  return {
    days,
    inputs: {
      trendRatio,
      referenceDates: Object.fromEntries(days.map((d) => [d.fecha, d.inputs.referenceDates])),
      samples: Object.fromEntries(days.map((d) => [d.fecha, d.inputs.samples])),
    },
  };
}
