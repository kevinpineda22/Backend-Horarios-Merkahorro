import { addDays } from "../domain/dates.js";
import { ABSENCE_TYPES, normalizeAbsences } from "../domain/absences.js";

/**
 * Absences port (R-d): reads ALL non-cancelled blocking novedades overlapping the target
 * week at service level, without user or sede scoping (null-sede rows included), and maps
 * them to the { absences, warnings } shape the availability step consumes.
 */
export function createAbsencesPort(novedadesRepo) {
  if (typeof novedadesRepo?.listActiveOverlapping !== "function") {
    throw new Error("novedadesRepo with listActiveOverlapping() is required");
  }

  return {
    async getAbsences({ weekStart, blockingTypes = ABSENCE_TYPES }) {
      const tipos = ABSENCE_TYPES.filter((t) => blockingTypes.includes(t));
      const rows = await novedadesRepo.listActiveOverlapping({
        desde: weekStart,
        hasta: addDays(weekStart, 6),
        tipos,
      });
      // A non-array result must fail loudly: treating it as "no absences" would free cashiers.
      if (!Array.isArray(rows)) throw new Error("Unexpected novedades result");
      return normalizeAbsences(rows, tipos);
    },
  };
}
