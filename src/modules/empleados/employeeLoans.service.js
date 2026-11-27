import { canAccessSede } from "../../shared/http/authorize.js";
import { createHttpError } from "../../shared/http/HttpError.js";
import { normalizeCedula } from "../../shared/cedula.js";
import { addDays, bogotaToday, mondayOf } from "../sugerido/domain/dates.js";
import { LoanExistsError, LoanSedeMissingError } from "./employeeLoans.supabase.js";

const WRITER_ROLES = ["admin", "planner"];

const forbiddenRole = () => createHttpError(403, "No tienes permisos para realizar esta acción.", "FORBIDDEN_ROLE");
const forbiddenSede = () => createHttpError(403, "No tienes acceso a esta sede.", "FORBIDDEN_SEDE");
const loanExists = () => createHttpError(409, "Esta persona ya está prestada esa semana.", "LOAN_EXISTS");

/**
 * Loans of an employee between sedes: a leader lends one of her sede's people to another sede for ONE full week and it
 * applies at once. Ports:
 *   repo             employeeLoans.supabase.js (listActiveByWeek / findActive / findActiveById / create / revoke)
 *   empleadosService findByCedula(cedula) -> the directory row (active or pre-contractual) or null
 *   sedeRepo         getSede(sedeId) (404 SEDE_NOT_MAPPED when unknown, inactive or without bodegas) / listSedes() (names)
 *   shiftsRepo       hasShiftsInSedeWeek({ cedula, sedeId, from, to }) -> boolean (any tipo, any schedule of the sede)
 * Who creates or cancels: an admin, or a planner whose access covers the person's HOME sede (same rule as the cashier
 * marks). Viewers only read.
 */
export function createEmployeeLoansService({ repo, empleadosService, sedeRepo, shiftsRepo, now = () => new Date() }) {
  const assertWriter = (access) => {
    if (!access || !WRITER_ROLES.includes(access.role)) throw forbiddenRole();
  };

  async function sedeNames() {
    return new Map((await sedeRepo.listSedes()).map((s) => [s.sedeId, s.nombre]));
  }

  async function toDtos(loans) {
    if (loans.length === 0) return [];
    const names = await sedeNames();
    return Promise.all(
      loans.map(async (loan) => {
        const employee = await empleadosService.findByCedula(loan.cedula);
        return {
          id: loan.id,
          cedula: loan.cedula,
          nombre: employee?.nombre ?? null,
          cargo: employee?.cargo ?? null,
          homeSedeId: loan.homeSedeId,
          homeSedeNombre: names.get(loan.homeSedeId) ?? loan.homeSedeId,
          hostSedeId: loan.hostSedeId,
          hostSedeNombre: names.get(loan.hostSedeId) ?? loan.hostSedeId,
          weekStart: loan.weekStart,
          motivo: loan.motivo ?? null,
          createdAt: loan.createdAt ?? null,
        };
      }),
    );
  }

  const weekRange = (weekStart) => ({ from: weekStart, to: addDays(weekStart, 6) });

  return {
    /** Active loans of the week. Admin sees all; anybody else only those whose home OR host sede they can access. */
    async list(access, { weekStart }) {
      if (!access) throw forbiddenRole();
      const loans = (await repo.listActiveByWeek(weekStart)).filter(
        (l) => canAccessSede(access, l.homeSedeId) || canAccessSede(access, l.hostSedeId),
      );
      return toDtos(loans);
    },

    async create(access, user, { cedula: cedulaInput, hostSedeId, weekStart, motivo = null }) {
      assertWriter(access);
      const cedula = normalizeCedula(cedulaInput);
      const employee = await empleadosService.findByCedula(cedula);
      if (!employee) throw createHttpError(404, "Empleado no encontrado.", "EMPLEADO_NOT_FOUND");
      const homeSedeId = employee.sedeId ?? null;
      if (homeSedeId === null) {
        throw createHttpError(409, "Esta persona no tiene una sede asignada.", "EMPLEADO_SIN_SEDE");
      }
      // The access that matters is the one over the HOME sede: the planner of the host alone cannot take people.
      if (!canAccessSede(access, homeSedeId)) throw forbiddenSede();
      if (hostSedeId === homeSedeId) {
        throw createHttpError(400, "La sede que recibe debe ser distinta a la sede de la persona.", "LOAN_SAME_SEDE");
      }
      await sedeRepo.getSede(hostSedeId); // unmapped / inactive -> 404 SEDE_NOT_MAPPED
      if (weekStart < mondayOf(bogotaToday(now()))) {
        throw createHttpError(400, "No puedes prestar a una persona en una semana que ya pasó.", "LOAN_WEEK_PAST");
      }
      if (await repo.findActive(cedula, weekStart)) throw loanExists();
      if (await shiftsRepo.hasShiftsInSedeWeek({ cedula, sedeId: homeSedeId, ...weekRange(weekStart) })) {
        throw createHttpError(409, "Tiene turnos guardados en su sede esa semana: quítalos primero.", "LOAN_HAS_SHIFTS");
      }
      let loan;
      try {
        loan = await repo.create({ cedula, homeSedeId, hostSedeId, weekStart, motivo: motivo ?? null, userId: user.id });
      } catch (err) {
        if (err instanceof LoanExistsError) throw loanExists();
        if (err instanceof LoanSedeMissingError) {
          throw createHttpError(404, "La sede no está configurada para el sugerido.", "SEDE_NOT_MAPPED");
        }
        throw err;
      }
      // Race mitigation: shifts saved between the check above and the insert would be orphaned by the loan. A full fix needs
      // the loan check inside shifts_save_week, under the per-cedula advisory lock (not done yet).
      if (await shiftsRepo.hasShiftsInSedeWeek({ cedula, sedeId: homeSedeId, ...weekRange(weekStart) })) {
        await repo.revoke({ id: loan.id, userId: user.id });
        throw createHttpError(409, "Tiene turnos guardados en su sede esa semana: quítalos primero.", "LOAN_HAS_SHIFTS");
      }
      return (await toDtos([loan]))[0];
    },

    async cancel(access, user, id) {
      assertWriter(access);
      const loan = await repo.findActiveById(id);
      if (!loan) throw createHttpError(404, "Préstamo no encontrado.", "LOAN_NOT_FOUND");
      if (!canAccessSede(access, loan.homeSedeId)) throw forbiddenSede();
      if (loan.weekStart < mondayOf(bogotaToday(now()))) {
        throw createHttpError(400, "No puedes cancelar el préstamo de una semana que ya pasó.", "LOAN_WEEK_PAST");
      }
      if (await shiftsRepo.hasShiftsInSedeWeek({ cedula: loan.cedula, sedeId: loan.hostSedeId, ...weekRange(loan.weekStart) })) {
        throw createHttpError(409, "Ya tiene turnos en la sede que la recibió: quítalos primero.", "LOAN_HAS_SHIFTS");
      }
      const revoked = await repo.revoke({ id, userId: user.id });
      if (!revoked) throw createHttpError(404, "Préstamo no encontrado.", "LOAN_NOT_FOUND");
      return (await toDtos([revoked]))[0];
    },
  };
}
