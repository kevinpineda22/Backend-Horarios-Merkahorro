import { normalizeCedula, isValidCedula } from "../../../shared/cedula.js";
import { normalizeSedeAlias as fold } from "../../../shared/sedeAlias.js";

/**
 * People hired but without a SIESA contract yet (pre-contractual). Their cargo and sede were typed in the self-service
 * form, so they come in many spellings: both are translated to the SIESA ones the scheduler knows.
 */

// Sede list of the self-service form (and a few typed by hand) -> our sede.
const SEDES = new Map([
  ["copacabana plaza", "copacabana"],
  ["villa hermosa", "villahermosa"],
  ["villahermosa", "villahermosa"],
  ["supermercados barbosa", "barbosa"],
  ["girardota llano", "girardota-llano"],
  ["llano", "girardota-llano"],
  ["girardota parque", "girardota-parque"],
  ["parque", "girardota-parque"],
  ["copacabana san juan", "san-juan"],
  ["copacabana vegas", "las-vegas"],
]);

const SEPARATOR = "[\\s\\-/]*";
const STOCKER = new RegExp(`^cajer[oa]${SEPARATOR}surtid+or(a)?$`);
const PAC = new RegExp(`^cajer[oa]${SEPARATOR}pac$`);

/** "cajera-surtidora" -> "CAJERO - SURTIDOR", "CAJERA" -> "CAJERO (A)"; any other cargo is only trimmed and uppercased. */
export function normalizeTypedCargo(value) {
  const cargo = fold(value);
  if (STOCKER.test(cargo)) return "CAJERO - SURTIDOR";
  if (PAC.test(cargo)) return "CAJERO PAC";
  if (cargo === "cajero" || cargo === "cajera") return "CAJERO (A)";
  return String(value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

/** Directory rows of the pre-contractual people; whoever is already active (`activeCedulas`) is left out. */
export function mapPrecontractuales(source, aliasMap, activeCedulas) {
  const byCedula = new Map();
  for (const raw of Array.isArray(source) ? source : []) {
    const cedula = normalizeCedula(raw?.cedula);
    if (raw?.precontractual !== true || !isValidCedula(cedula) || activeCedulas.has(cedula) || byCedula.has(cedula)) continue;
    const sede = typeof raw.sede === "string" ? raw.sede.replace(/\s+/g, " ").trim() : "";
    const key = fold(sede);
    const sedeId = aliasMap.get(key) ?? SEDES.get(key) ?? null;
    byCedula.set(cedula, {
      cedula,
      nombre: typeof raw.nombre === "string" ? raw.nombre.trim() : "",
      cargo: normalizeTypedCargo(raw.cargo),
      sedeId,
      sedeNombre: sede || null,
      activo: true,
      unmappedSede: sedeId === null,
      restriccionOperativa: null,
      precontractual: true,
    });
  }
  return [...byCedula.values()];
}
