import { createHttpError } from "../../shared/http/HttpError.js";

const ACCESS_COLUMNS =
  "id, user_id, role, sede_ids, created_by, created_at, updated_by, updated_at, revoked_by, revoked_at";
const PROFILE_COLUMNS = "user_id, nombre, correo";

// 003_accesos.sql RPC exception messages -> HTTP errors. Anything else is rethrown untouched.
const RPC_ERRORS = [
  ["LAST_ADMIN", 409, "No se puede dejar el sistema sin un administrador activo.", "LAST_ADMIN"],
  ["ACCESS_DUPLICATE", 409, "El usuario ya tiene un acceso activo.", "DUPLICATE_ACCESS"],
  ["ACCESS_NOT_FOUND", 404, "Acceso no encontrado.", "ACCESS_NOT_FOUND"],
];

function mapRpcError(error) {
  const message = String(error?.message ?? "");
  const hit = RPC_ERRORS.find(([token]) => message.includes(token));
  return hit ? createHttpError(hit[1], hit[2], hit[3]) : error;
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw mapRpcError(error);
  return data;
}

/** `sugerido_access` administration over the 003 RPCs (atomic, advisory-locked). */
export function createAccesosRepo(client) {
  return {
    async list({ incluirRevocados = false } = {}) {
      let q = client.from("sugerido_access").select(ACCESS_COLUMNS);
      if (!incluirRevocados) q = q.is("revoked_at", null);
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },

    /** ACTIVE row by id, or null. */
    async findById(id) {
      const { data, error } = await client
        .from("sugerido_access")
        .select(ACCESS_COLUMNS)
        .eq("id", id)
        .is("revoked_at", null)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },

    async findExistingSedeIds(ids) {
      const { data, error } = await client.from("sugerido_sedes").select("sede_id").in("sede_id", ids);
      if (error) throw error;
      return (data ?? []).map((r) => r.sede_id);
    },

    create: ({ userId, role, sedeIds, actor }) =>
      rpc(client, "sugerido_access_create", { p_user_id: userId, p_role: role, p_sede_ids: sedeIds, p_actor: actor }),

    update: ({ id, role, sedeIds, actor }) =>
      rpc(client, "sugerido_access_update", { p_id: id, p_role: role, p_sede_ids: sedeIds, p_actor: actor }),

    revoke: ({ id, actor }) => rpc(client, "sugerido_access_revoke", { p_id: id, p_actor: actor }),
  };
}

// Characters with meaning inside a PostgREST `or=` filter or an ilike pattern (`%` and `_` are wildcards).
const FILTER_SYNTAX = /[,()%_*\\"']/g;

/** Read-only `profiles` lookup. Selects ONLY user_id, nombre, correo. */
export function createProfilesRepo(client) {
  return {
    async findById(userId) {
      const { data, error } = await client
        .from("profiles")
        .select(PROFILE_COLUMNS)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },

    async search(term, limit) {
      const safe = String(term).replace(FILTER_SYNTAX, "").trim();
      if (!safe) return [];
      const { data, error } = await client
        .from("profiles")
        .select(PROFILE_COLUMNS)
        .or(`nombre.ilike.%${safe}%,correo.ilike.%${safe}%`)
        .order("nombre", { ascending: true })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
  };
}
