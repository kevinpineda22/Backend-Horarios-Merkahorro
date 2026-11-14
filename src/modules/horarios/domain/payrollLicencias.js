import { addDays, diffDays } from "../../sugerido/domain/dates.js";

// Licences in the payroll report (information for nómina, not a SIESA concept):
//   * Remunerada: the licence days are paid as if worked, at 7 h a day (42 h / 6 days), but a week is never paid above
//     42 h: paid licence hours = min(licence days x 7, 42 - hours worked that week).
//   * No remunerada: the licence days are NOT paid; the report lists them as days to deduct.
// A licence day that was worked anyway is neither paid as licence nor deducted. Only days inside [from, to] count.

export const LICENCIA_DAY_HOURS = 7;
const WEEK_HOURS = 42;

const inRange = (fecha, lic) => fecha >= lic.fechaInicio && fecha <= lic.fechaFin;
const roundHalf = (hours) => Math.round(hours * 2) / 2;

/**
 * @param licencias the person's non-cancelled licences: [{ subtipo: "Remunerada" | "No remunerada", fechaInicio, fechaFin }]
 * @param weeks the person's weeks of the period: [{ weekStart, workedHours }]
 * @param workedDates Set of dates with a worked shift
 * @returns { licenciaRemuneradaHoras, licenciaNoRemuneradaDias }
 */
export function licenciaSummary({ licencias = [], weeks = [], workedDates = new Set(), from, to }) {
  const paid = licencias.filter((l) => l.subtipo === "Remunerada");
  const unpaid = licencias.filter((l) => l.subtipo === "No remunerada");
  let paidHours = 0;
  let unpaidDays = 0;
  for (const week of weeks) {
    let paidDays = 0;
    for (let i = 0; i < 7; i += 1) {
      const fecha = addDays(week.weekStart, i);
      if (diffDays(fecha, from) < 0 || diffDays(to, fecha) < 0 || workedDates.has(fecha)) continue;
      if (paid.some((l) => inRange(fecha, l))) paidDays += 1;
      else if (unpaid.some((l) => inRange(fecha, l))) unpaidDays += 1;
    }
    paidHours += Math.min(paidDays * LICENCIA_DAY_HOURS, Math.max(0, WEEK_HOURS - (week.workedHours ?? 0)));
  }
  return { licenciaRemuneradaHoras: roundHalf(paidHours), licenciaNoRemuneradaDias: unpaidDays };
}
