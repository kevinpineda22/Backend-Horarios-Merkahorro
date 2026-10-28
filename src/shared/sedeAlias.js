// Sede alias key. Must match the SQL function sugerido_normalize_alias (migration 003):
// lower(unaccent(btrim(regexp_replace(alias, '\s+', ' ', 'g')))).
export function normalizeSedeAlias(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}
