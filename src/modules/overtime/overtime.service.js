import { createHttpError } from "../../shared/http/HttpError.js";
import { canAccessSede } from "../../shared/http/authorize.js";
import { decisionEmail, requestEmail } from "./overtimeEmail.js";

// Extra overtime requests (migration 014). The team of a sede has 10 h of overtime a week; when a leader needs more,
// they ask for a number of hours with a reason. The approvers (Anny, Ramiro) get an e-mail, open Autorizaciones in the
// app and approve or reject; ONE decision is enough. Approved hours raise that sede-week's overtime budget.

export const DEFAULT_APPROVERS = Object.freeze(["analista@merkahorrosas.com", "operaciones@merkahorrosas.com"]);
const WRITER_ROLES = ["admin", "planner"];

/** "a@x.co, B@x.co" -> ["a@x.co", "b@x.co"] (trimmed, lowercase, unique); the default list when empty. */
export function parseApprovers(value) {
  const list = [...new Set(String(value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  return list.length ? list : [...DEFAULT_APPROVERS];
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const weekText = (weekStart) => {
  const [y, m, d] = weekStart.split("-").map(Number);
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  return `${d} de ${MONTHS[m - 1]} al ${end.getUTCDate()} de ${MONTHS[end.getUTCMonth()]} de ${end.getUTCFullYear()}`;
};

/**
 * Ports:
 *   repo         findSede / findPending / create / listByWeek / listByStatus / findById / decide (conditional on PENDIENTE)
 *   profilesRepo findById -> { nombre, correo }
 *   mailer       send({ to, subject, html, text }); a failure never undoes a request or a decision
 */
export function createOvertimeService({ repo, profilesRepo, mailer, approvers = DEFAULT_APPROVERS, appUrl = "https://merkahorro.com", logger = console }) {
  const approverSet = new Set(approvers.map((e) => e.toLowerCase()));
  // Only a confirmed e-mail counts: someone who signs up with an approver's address without confirming it is not one.
  const isApprover = (user) => Boolean(user?.email) && user.emailConfirmed !== false && approverSet.has(String(user.email).toLowerCase());
  const link = `${appUrl.replace(/\/+$/, "")}/horarios-merkahorro?vista=autorizaciones`;

  function profileResolver() {
    const cache = new Map();
    return (id) => {
      if (!id || !profilesRepo) return Promise.resolve(null);
      if (!cache.has(id)) cache.set(id, profilesRepo.findById(id).catch(() => null));
      return cache.get(id);
    };
  }

  async function toDto(row, profileOf, sedeNombre) {
    return {
      id: row.id,
      sedeId: row.sedeId,
      sedeNombre: sedeNombre ?? null,
      weekStart: row.weekStart,
      hours: Number(row.hours),
      motivo: row.motivo,
      status: row.status,
      requestedBy: (await profileOf(row.requestedBy))?.nombre ?? null,
      requestedAt: row.requestedAt,
      decidedBy: (await profileOf(row.decidedBy))?.nombre ?? null,
      decidedAt: row.decidedAt,
      decisionComment: row.decisionComment ?? null,
    };
  }

  async function sendSafely(message) {
    try {
      await mailer.send(message);
      return true;
    } catch (err) {
      logger?.error?.("[overtime] e-mail not sent:", err?.message);
      return false;
    }
  }

  const assertApprover = (user) => {
    if (!isApprover(user)) throw createHttpError(403, "Solo los aprobadores de horas extra pueden hacer esto.", "NOT_AN_APPROVER");
  };

  return {
    async me(user) {
      return { isApprover: isApprover(user) };
    },

    /** A leader (admin / planner of the sede) asks for extra overtime hours for one sede-week. */
    async request(access, user, sedeId, weekStart, { hours, motivo }) {
      if (!access || !WRITER_ROLES.includes(access.role)) throw createHttpError(403, "No tienes permisos para realizar esta acción.", "FORBIDDEN_ROLE");
      if (!canAccessSede(access, sedeId)) throw createHttpError(403, "No tienes acceso a esta sede.", "FORBIDDEN_SEDE");
      const sede = await repo.findSede(sedeId);
      if (!sede) throw createHttpError(404, "Sede no encontrada.", "SEDE_NOT_FOUND");
      if (await repo.findPending(sedeId, weekStart)) {
        throw createHttpError(409, "Ya hay una solicitud de horas extra pendiente para esta semana.", "OVERTIME_REQUEST_PENDING");
      }
      const row = await repo.create({ sedeId, weekStart, hours, motivo, requestedBy: user.id });
      const profileOf = profileResolver();
      const request = await toDto(row, profileOf, sede.nombre);
      const who = request.requestedBy ?? user.email ?? "Un líder";
      const emailSent = await sendSafely({
        to: [...approverSet],
        ...requestEmail({ requester: who, sedeNombre: sede.nombre, weekText: weekText(weekStart), hours, motivo, link }),
      });
      return { request, emailSent };
    },

    /** The requests of one sede-week (newest first) and the hours approved for it. */
    async forWeek(access, sedeId, weekStart) {
      if (!canAccessSede(access, sedeId)) throw createHttpError(403, "No tienes acceso a esta sede.", "FORBIDDEN_SEDE");
      const rows = await repo.listByWeek(sedeId, weekStart);
      const profileOf = profileResolver();
      const items = await Promise.all(
        [...rows].sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt))).map((r) => toDto(r, profileOf)),
      );
      const approvedHours = rows.filter((r) => r.status === "APROBADA").reduce((sum, r) => sum + Number(r.hours), 0);
      return { items, approvedHours };
    },

    async listForApprovers(user, { status } = {}) {
      assertApprover(user);
      const rows = await repo.listByStatus({ status });
      const profileOf = profileResolver();
      const sedes = new Map();
      const sedeName = async (id) => {
        if (!sedes.has(id)) sedes.set(id, (await repo.findSede(id))?.nombre ?? id);
        return sedes.get(id);
      };
      return Promise.all(rows.map(async (r) => toDto(r, profileOf, await sedeName(r.sedeId))));
    },

    /** One approver's decision. Only a PENDIENTE request can be decided (a race resolves to 409 for the second one). */
    async decide(user, id, { decision, comment = null }) {
      assertApprover(user);
      const current = await repo.findById(id);
      if (!current) throw createHttpError(404, "No encontramos esa solicitud.", "OVERTIME_REQUEST_NOT_FOUND");
      if (current.requestedBy === user.id) {
        throw createHttpError(403, "No puedes decidir tu propia solicitud: la decide el otro aprobador.", "SELF_DECISION");
      }
      const decided = current.status === "PENDIENTE" ? await repo.decide({ id, status: decision, decidedBy: user.id, comment }) : null;
      if (!decided) throw createHttpError(409, "Esta solicitud ya fue decidida por otro aprobador.", "OVERTIME_ALREADY_DECIDED");
      const profileOf = profileResolver();
      const sede = await repo.findSede(decided.sedeId);
      const request = await toDto(decided, profileOf, sede?.nombre ?? decided.sedeId);
      const leader = await profileOf(decided.requestedBy);
      let emailSent = false;
      if (leader?.correo) {
        const approved = decision === "APROBADA";
        emailSent = await sendSafely({
          to: [leader.correo],
          ...decisionEmail({ approver: request.decidedBy ?? "Un aprobador", approved, sedeNombre: request.sedeNombre, weekText: weekText(decided.weekStart), hours: decided.hours, comment }),
        });
      }
      return { request, emailSent };
    },
  };
}
