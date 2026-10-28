/**
 * `sugerido_access` adapter for loadAccess: { role, sede_ids, revoked_at } for the user's
 * ACTIVE row, or null. Soft-revoked rows (revoked_at set) are never returned.
 */
export function createAccessRepo(client) {
  return {
    async findByUserId(userId) {
      const { data, error } = await client
        .from("sugerido_access")
        .select("role, sede_ids, revoked_at")
        .eq("user_id", userId)
        .is("revoked_at", null)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  };
}
