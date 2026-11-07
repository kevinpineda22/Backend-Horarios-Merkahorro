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
 * Missing cashiers, counting only the ones who could ever sit: max(0, min(required, registers) - available).
 * Unknown registers: plain required - available. `required` is never capped by this.
 */
export function shortfallFor({ required, available }, registers) {
  if (required === null) return null;
  const need = isCount(registers) ? Math.min(required, registers) : required;
  return Math.max(0, need - available);
}

// ok <-> shortfall follows the shortfall; closed / unknown never change.
const statusFor = (status, shortfall) => (status === "ok" || status === "shortfall" ? (shortfall > 0 ? "shortfall" : "ok") : status);

/**
 * Run computation: limits suggested to the registers and recomputes shortfall / status against them.
 * `required` is left alone so the real demand stays visible.
 */
export function capSlots(slots, registers) {
  if (!isCount(registers)) return slots;
  return slots.map((s) => {
    const suggested = s.suggested !== null && s.suggested > registers ? registers : s.suggested;
    const shortfall = shortfallFor(s, registers);
    return { ...s, suggested, shortfall, status: statusFor(s.status, shortfall) };
  });
}

/**
 * Read: aligns a composed view slot with the CURRENT registers. Shortfall / status follow them, and `final`
 * above them is clamped and flagged (`cappedByRegisters: true`; absent otherwise). Stored overrides and the
 * stored suggestion are never rewritten, so lifting the cap later brings the original values back.
 */
export function reconcileSlots(slots, registers) {
  return slots.map((s) => {
    const shortfall = shortfallFor(s, registers);
    const base = { ...s, shortfall, status: statusFor(s.status, shortfall) };
    if (!isCount(registers) || s.final === null || s.final <= registers) return base;
    return { ...base, final: registers, difference: s.suggested === null ? null : registers - s.suggested, cappedByRegisters: true };
  });
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
