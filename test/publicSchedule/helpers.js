export const SCHED_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SCHED_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const SCHED_OLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// 2026-11-12 (Thursday) in Bogota; the current Monday is 2026-11-09.
export const NOW = new Date("2026-11-12T15:00:00Z");

export const EMPLOYEE = Object.freeze({
  cedula: "123456",
  nombre: "Ana Perez",
  cargo: "Cajera",
  sedeId: "copacabana",
  sedeNombre: "Copacabana",
  activo: true,
  restriccionOperativa: "secret restriction",
});

export const shiftRow = (over = {}) => ({
  schedule_id: SCHED_A,
  fecha: "2026-11-10",
  tipo: "TRABAJO",
  start_time: "08:00:00",
  end_time: "17:00:00",
  break_minutes: 60,
  lunch_start: "12:00:00",
  ...over,
});

/** Fakes of the three collaborators of the public schedule service. */
export function fakes({ employee = EMPLOYEE, schedules, shifts = [], novedades = [], directoryError = null } = {}) {
  const calls = [];
  const empleadosService = {
    async findActiveByCedula(cedula) {
      calls.push(["findActiveByCedula", cedula]);
      if (directoryError) throw directoryError;
      return employee && employee.cedula === cedula ? employee : null;
    },
  };
  const horariosRepo = {
    async listPublishedSchedulesInRange(args) {
      calls.push(["listPublishedSchedulesInRange", args]);
      return (
        schedules ?? [
          { id: SCHED_A, week_start: "2026-11-09" },
          { id: SCHED_B, week_start: "2026-11-16" },
        ]
      );
    },
    async listShiftsByCedulaInSchedules(args) {
      calls.push(["listShiftsByCedulaInSchedules", args]);
      return shifts.filter((s) => args.scheduleIds.includes(s.schedule_id));
    },
  };
  const novedadesRepo = {
    async listPublicByCedula(args) {
      calls.push(["listPublicByCedula", args]);
      return novedades;
    },
  };
  return { calls, empleadosService, horariosRepo, novedadesRepo };
}
