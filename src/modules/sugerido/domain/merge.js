import { computeAvailability } from "./availability.js";
import { computeHeadcount } from "./headcount.js";

const SLOT_HOURS = 0.25;

function buildSlot(h, available) {
  const suggested = h.required === null ? null : Math.min(h.required, available);
  const shortfall = h.required === null ? null : h.required - suggested;
  const status = h.status === "ok" && shortfall > 0 ? "shortfall" : h.status;
  return {
    franja: h.franja,
    forecastDocs: h.forecastDocs,
    required: h.required,
    available,
    suggested,
    override: null,
    final: suggested,
    diff: suggested === null ? null : 0,
    shortfall,
    status,
  };
}

/**
 * Combines forecast + productivity + availability into the per-day / per-slot result.
 * forecast: forecastWeek() output. pool/absences feed computeAvailability.
 */
export function assembleWeek({ weekStart, forecast, productivity, settings, pool, absences }) {
  const headcounts = forecast.days.map((day) =>
    computeHeadcount({ slots: day.slots.map((s) => ({ franja: s.franja, docs: s.docs })), productivity, settings })
  );

  const requiredHoursByDay = {};
  forecast.days.forEach((day, i) => {
    requiredHoursByDay[day.fecha] = headcounts[i].reduce((s, h) => s + (h.required ?? 0) * SLOT_HOURS, 0);
  });

  const avail = computeAvailability({ weekStart, pool, absences, settings, requiredHoursByDay });

  const days = forecast.days.map((day, i) => ({
    fecha: day.fecha,
    dayType: day.dayType,
    holidayName: day.holidayName,
    noHistory: day.noHistory,
    lowHistory: day.lowHistory,
    available: avail.available[day.fecha],
    dailyShortfall: avail.dailyShortfall[day.fecha],
    forecast: day.totals,
    slots: headcounts[i].map((h) => buildSlot(h, avail.available[day.fecha])),
  }));

  return {
    productivity,
    inputs: { ...forecast.inputs, settings },
    flags: { noProductivity: !(productivity > 0) },
    capacity: {
      requiredH: avail.requiredH,
      ordinaryCapH: avail.ordinaryCapH,
      maxCapH: avail.maxCapH,
      overtimeNeeded: avail.overtimeNeeded,
      weeklyShortfall: avail.weeklyShortfall,
    },
    days,
  };
}

/**
 * Overlays the override layer: final = override ?? suggested, diff = final - suggested.
 * overrides: [{ fecha, franja, headcount }]. Returns new days; the input is not mutated.
 * Overrides for slots absent from the suggestion are ignored.
 */
export function applyOverrides(days, overrides) {
  const byKey = new Map(overrides.map((o) => [`${o.fecha}|${o.franja}`, o.headcount]));
  return days.map((day) => ({
    ...day,
    slots: day.slots.map((s) => {
      const override = byKey.get(`${day.fecha}|${s.franja}`) ?? null;
      const final = override ?? s.suggested;
      const diff = final === null || s.suggested === null ? null : final - s.suggested;
      return { ...s, override, final, diff };
    }),
  }));
}
