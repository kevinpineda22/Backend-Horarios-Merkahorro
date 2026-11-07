/**
 * Physical checkout registers ("puestos de pago") of a sede. They cap how many cashiers can work at
 * the same time, so the recommendation never suggests more than the sede has registers.
 * Unknown (null) means no cap: the system never blocks on missing data.
 */
export const REGISTERS_CAP_CODE = "REGISTERS_CAP";

const isCount = (n) => Number.isInteger(n) && n > 0;

/** override ?? derived ?? null. A derived count of 0 (or anything that is not a count) is unknown. */
export function effectiveRegisters({ derived, override } = {}) {
  if (isCount(override)) return override;
  return isCount(derived) ? derived : null;
}

/** Sums the per-bodega register counts of one sede; no data (or a total of 0) is unknown. */
export function derivedRegisters(bodegas, countsByBodega) {
  const total = bodegas.reduce((sum, b) => sum + (isCount(countsByBodega[b]) ? countsByBodega[b] : 0), 0);
  return total > 0 ? total : null;
}

/**
 * Limits suggested to the registers. `required` is left alone so the real demand stays visible;
 * shortfall and status are left alone too (a register cap is not a shortage of staff).
 */
export function capSlots(slots, registers) {
  if (!isCount(registers)) return slots;
  return slots.map((s) => (s.suggested !== null && s.suggested > registers ? { ...s, suggested: registers } : s));
}

/** Slots whose real demand exceeds the registers. */
export function countOverRegisters(slots, registers) {
  if (!isCount(registers)) return 0;
  return slots.filter((s) => s.required !== null && s.required > registers).length;
}

/** Run warning (plain string, like the other warnings), or null when the cap changed nothing. */
export function registersWarning({ registers, cappedSlots }) {
  if (!cappedSlots) return null;
  const franjas = cappedSlots === 1 ? "1 franja requiere" : `${cappedSlots} franjas requieren`;
  const puestos = registers === 1 ? "1 puesto de pago" : `${registers} puestos de pago`;
  return `${REGISTERS_CAP_CODE}: ${franjas} más cajeras que ${registers === 1 ? "el" : "los"} ${puestos} de la sede; el sugerido se limitó a ${registers}.`;
}
