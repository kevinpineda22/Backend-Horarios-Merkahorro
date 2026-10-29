import { createHttpError } from "../../shared/http/HttpError.js";

export const LOOKUP_LIMIT = 20;

const toDto = (r) => ({
  id: r.id,
  userId: r.user_id,
  role: r.role,
  sedeIds: r.sede_ids ?? null,
  createdBy: r.created_by ?? null,
  createdAt: r.created_at ?? null,
  updatedBy: r.updated_by ?? null,
  updatedAt: r.updated_at ?? null,
  revokedBy: r.revoked_by ?? null,
  revokedAt: r.revoked_at ?? null,
});

/**
 * Access administration use cases. Ports:
 *   repo         list / findById / findExistingSedeIds / create / update / revoke
 *   profilesRepo findById / search (read-only, identifying fields only)
 * Role checks live in the routes; the audit actor is always the authenticated user.
 */
export function createAccesosService({ repo, profilesRepo }) {
  async function assertSedesExist(sedeIds) {
    if (!sedeIds) return;
    const found = new Set(await repo.findExistingSedeIds(sedeIds));
    const missing = sedeIds.filter((id) => !found.has(id));
    if (missing.length) {
      const err = createHttpError(400, `Sede no encontrada: ${missing.join(", ")}`, "SEDE_NOT_FOUND");
      err.details = missing.map((id) => ({ path: "body.sedeIds", message: `Sede inexistente: ${id}` }));
      throw err;
    }
  }

  return {
    async list({ incluirRevocados = false } = {}) {
      return { data: (await repo.list({ incluirRevocados })).map(toDto) };
    },

    async create(user, { userId, role, sedeIds }) {
      if (!(await profilesRepo.findById(userId))) {
        throw createHttpError(400, "El usuario no existe.", "USER_NOT_FOUND");
      }
      await assertSedesExist(sedeIds);
      const row = await repo.create({ userId, role, sedeIds, actor: user.id });
      return { data: toDto(row) };
    },

    async update(user, id, patch) {
      const current = await repo.findById(id);
      if (!current) throw createHttpError(404, "Acceso no encontrado.", "ACCESS_NOT_FOUND");
      const role = patch.role ?? current.role;
      const sedeIds = patch.sedeIds !== undefined ? patch.sedeIds : (current.sede_ids ?? null);
      if (patch.sedeIds !== undefined) await assertSedesExist(sedeIds);
      const row = await repo.update({ id, role, sedeIds, actor: user.id });
      return { data: toDto(row) };
    },

    async revoke(user, id) {
      return { data: toDto(await repo.revoke({ id, actor: user.id })) };
    },

    async searchUsers(q) {
      const rows = await profilesRepo.search(q, LOOKUP_LIMIT);
      // Re-project so nothing beyond the identifying fields can ever leak.
      return {
        data: rows.slice(0, LOOKUP_LIMIT).map((p) => ({ userId: p.user_id, nombre: p.nombre, correo: p.correo })),
      };
    },
  };
}
