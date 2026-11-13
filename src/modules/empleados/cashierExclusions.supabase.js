const TABLE = "cashier_exclusions";
const COLUMNS = "cedula, sede_id, motivo, created_by, created_at, kind";
const UNIQUE_VIOLATION = "23505";

const toDto = (r) => ({
  cedula: r.cedula,
  sedeId: r.sede_id ?? null,
  motivo: r.motivo ?? null,
  createdBy: r.created_by,
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  // "exclude" = Solo surtidor / no programar en caja (011); "include" = programar en caja with another cargo (012).
  kind: r.kind ?? "exclude",
});

/**
 * Cashier marks over `cashier_exclusions`: "Solo surtidor / no programar en caja" (kind "exclude", migration 011) and
 * "Programar en caja" for somebody whose cargo is not a cashier one (kind "include", migration 012). Soft revoke: a row is never
 * deleted, so the table is its own history. At most one ACTIVE row (revoked_at null) per cedula, of either kind,
 * enforced by the DB.
 */
export function createCashierExclusionsRepo(client, { now = () => new Date() } = {}) {
  async function findActive(cedula) {
    const { data, error } = await client.from(TABLE).select(COLUMNS).eq("cedula", cedula).is("revoked_at", null).maybeSingle();
    if (error) throw error;
    return data ? toDto(data) : null;
  }

  return {
    /** Every active exclusion, in ONE query. */
    async listActive() {
      const { data, error } = await client.from(TABLE).select(COLUMNS).is("revoked_at", null).order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(toDto);
    },

    /** Inserts the active row. A concurrent duplicate returns the row that won instead of failing. */
    async create({ cedula, sedeId, motivo, userId, kind = "exclude" }) {
      const { data, error } = await client
        .from(TABLE)
        .insert({ cedula, sede_id: sedeId ?? null, motivo: motivo ?? null, created_by: userId, kind })
        .select(COLUMNS)
        .single();
      if (error?.code === UNIQUE_VIOLATION) {
        const existing = await findActive(cedula);
        if (existing) return existing;
      }
      if (error) throw error;
      return toDto(data);
    },

    /** Soft-revokes the ACTIVE row of the cedula (only of that `kind` when given). true when there was one. */
    async revoke({ cedula, userId, kind = null }) {
      let query = client
        .from(TABLE)
        .update({ revoked_by: userId, revoked_at: now().toISOString() })
        .eq("cedula", cedula)
        .is("revoked_at", null);
      if (kind) query = query.eq("kind", kind);
      const { data, error } = await query.select("id");
      if (error) throw error;
      return (data ?? []).length > 0;
    },
  };
}
