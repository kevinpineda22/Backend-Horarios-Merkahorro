/** Reads `sugerido_sede_aliases` (alias PK already normalized by the 003 trigger) into a Map. */
export function createSedeAliasRepo(client) {
  return {
    async loadAliasMap() {
      const { data, error } = await client.from("sugerido_sede_aliases").select("alias, sede_id");
      if (error) throw error;
      return new Map((data ?? []).map((row) => [row.alias, row.sede_id]));
    },
  };
}
