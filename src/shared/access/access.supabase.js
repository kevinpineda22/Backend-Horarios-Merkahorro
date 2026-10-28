/** `sugerido_access` adapter for loadAccess: { role, sede_ids } for a user, or null. */
export function createAccessRepo(client) {
  return {
    async findByUserId(userId) {
      const { data, error } = await client
        .from("sugerido_access")
        .select("role, sede_ids")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  };
}
