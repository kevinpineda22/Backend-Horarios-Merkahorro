import test from "node:test";
import assert from "node:assert/strict";

import {
  REGISTERS_CAP_CODE,
  capSlots,
  countOverRegisters,
  derivedRegisters,
  effectiveRegisters,
  registersWarning,
} from "../../src/modules/sugerido/domain/registers.js";

test("effectiveRegisters: override wins over derived, derived over unknown", () => {
  assert.equal(effectiveRegisters({ derived: 10, override: 8 }), 8);
  assert.equal(effectiveRegisters({ derived: 10, override: null }), 10);
  assert.equal(effectiveRegisters({ derived: null, override: 6 }), 6);
  assert.equal(effectiveRegisters({ derived: null, override: null }), null);
  assert.equal(effectiveRegisters({}), null);
});

test("effectiveRegisters: a derived count of 0 or a non-number is unknown, never a cap of 0", () => {
  assert.equal(effectiveRegisters({ derived: 0, override: null }), null);
  assert.equal(effectiveRegisters({ derived: Number.NaN, override: null }), null);
  assert.equal(effectiveRegisters({ derived: undefined, override: undefined }), null);
});

test("derivedRegisters: sums the per-bodega counts of the sede; no data or zero is unknown", () => {
  assert.equal(derivedRegisters(["A", "B"], { A: 6, B: 4, C: 9 }), 10);
  assert.equal(derivedRegisters(["A", "B"], { A: 6 }), 6);
  assert.equal(derivedRegisters(["A"], {}), null);
  assert.equal(derivedRegisters(["A"], { A: 0 }), null);
  assert.equal(derivedRegisters([], { A: 3 }), null);
});

const slot = (required, suggested, extra = {}) => ({ franja: "08:00", required, suggested, shortfall: 0, status: "ok", ...extra });

test("capSlots: suggested is limited to the registers, required stays uncapped", () => {
  const out = capSlots([slot(12, 12), slot(10, 10), slot(4, 4)], 10);
  assert.deepEqual(out.map((s) => [s.required, s.suggested]), [[12, 10], [10, 10], [4, 4]]);
});

test("capSlots: null suggestions stay null, input is not mutated, null registers is a no-op", () => {
  const input = [slot(null, null, { status: "unknown" }), slot(0, 0, { status: "closed" }), slot(12, 12)];
  const snapshot = structuredClone(input);
  const out = capSlots(input, 10);
  assert.deepEqual(input, snapshot);
  assert.equal(out[0].suggested, null);
  assert.equal(out[1].suggested, 0);
  assert.equal(out[2].suggested, 10);
  assert.deepEqual(capSlots(input, null), input);
});

test("capSlots: does not touch shortfall or status (a register cap is not a staffing shortage)", () => {
  const [s] = capSlots([slot(12, 12, { shortfall: 0, status: "ok" })], 10);
  assert.equal(s.shortfall, 0);
  assert.equal(s.status, "ok");
});

test("countOverRegisters: counts slots whose real demand exceeds the registers", () => {
  const slots = [slot(12, 12), slot(10, 10), slot(11, 5), slot(null, null), slot(2, 2)];
  assert.equal(countOverRegisters(slots, 10), 2);
  assert.equal(countOverRegisters(slots, null), 0);
  assert.equal(countOverRegisters(slots, 50), 0);
});

test("registersWarning: null when nothing is affected, otherwise a Spanish string tagged with the code", () => {
  assert.equal(registersWarning({ registers: 10, cappedSlots: 0 }), null);
  const w = registersWarning({ registers: 10, cappedSlots: 3 });
  assert.equal(typeof w, "string");
  assert.ok(w.startsWith(`${REGISTERS_CAP_CODE}:`));
  assert.match(w, /3 franjas/);
  assert.match(w, /10 puestos/);
  assert.match(registersWarning({ registers: 1, cappedSlots: 1 }), /1 franja /);
  assert.match(registersWarning({ registers: 1, cappedSlots: 1 }), /1 puesto /);
});
