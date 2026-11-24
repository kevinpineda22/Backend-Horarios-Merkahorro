/** Shifts of the cashier schedule of a sede-week as they are saved now, or null when it is not published. */
export function createPublishedShiftsPort(horariosRepo) {
  return {
    async listPublishedCashierShifts(sedeId, weekStart) {
      const schedule = await horariosRepo.findSchedule(sedeId, weekStart, "CAJEROS");
      return schedule?.state === "PUBLICADO" ? horariosRepo.listShifts(schedule.id) : null;
    },
  };
}
