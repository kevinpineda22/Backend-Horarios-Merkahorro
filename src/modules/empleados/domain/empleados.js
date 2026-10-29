import { normalizeCedula, isValidCedula } from "../../../shared/cedula.js";
import { normalizeSedeAlias } from "../../../shared/sedeAlias.js";

const text = (value) => (typeof value === "string" ? value.trim() : "");

function lookupSede(aliasMap, sede) {
  const key = normalizeSedeAlias(sede);
  if (!key) return null;
  // Own properties only: a sede named "constructor" or "__proto__" must stay unmapped.
  const id =
    aliasMap instanceof Map
      ? aliasMap.get(key)
      : aliasMap && typeof aliasMap === "object" && Object.hasOwn(aliasMap, key)
        ? aliasMap[key]
        : undefined;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

// Higher wins when two active rows share a cedula: a mapped sede beats an unmapped one.
// Ties keep the first occurrence, so the result is deterministic for a given input.
const rank = (row) => (row.sedeId ? 1 : 0);

/**
 * Maps trazabilidad service rows to the directory shape. Only the allowed keys are
 * emitted: the `restricciones` text (and anything else) never leaves this function.
 * Only rows with `activo === true` are kept (fail closed). Returns the rows plus counters:
 * `dropped` (invalid cedula), `inactive` (not strictly active), `duplicates`, and
 * `conflicts` (tied duplicates that disagree on sedeId). Counts only, never PII.
 */
export function mapEmpleados(source, aliasMap) {
  const byCedula = new Map();
  let dropped = 0;
  let duplicates = 0;
  let conflicts = 0;
  let inactive = 0;

  for (const raw of Array.isArray(source) ? source : []) {
    const cedula = normalizeCedula(raw?.cedula);
    if (!isValidCedula(cedula)) {
      dropped += 1;
      continue;
    }
    if (raw.activo !== true) {
      inactive += 1;
      continue;
    }
    const sedeId = lookupSede(aliasMap, raw.sede);
    const operativa = text(raw.restriccionOperativa);
    const row = {
      cedula,
      nombre: text(raw.nombre),
      cargo: text(raw.cargo),
      sedeId,
      activo: true,
      unmappedSede: sedeId === null,
      restriccionOperativa: operativa || null,
    };

    const current = byCedula.get(cedula);
    if (!current) {
      byCedula.set(cedula, row);
      continue;
    }
    duplicates += 1;
    if (rank(row) > rank(current)) byCedula.set(cedula, row);
    else if (rank(row) === rank(current) && row.sedeId !== current.sedeId) conflicts += 1;
  }

  return { rows: [...byCedula.values()], dropped, duplicates, conflicts, inactive };
}

/**
 * Keeps only the rows the caller may see. Admins and callers without a sede scope
 * (sedeIds null/undefined) see everything, including rows with an unmapped sede.
 * Scoped callers see only rows of their sedes and never unmapped ones.
 */
export function filterForAccess(rows, access) {
  if (!access) return [];
  if (access.role === "admin" || access.sedeIds == null) return rows;
  const allowed = new Set(access.sedeIds);
  return rows.filter((row) => row.sedeId !== null && allowed.has(row.sedeId));
}
