import test from "node:test";
import assert from "node:assert/strict";

import {
  REGISTERS_CAP_CODE,
  capSlots,
  countOverRegisters,
  derivedRegisters,
  effectiveRegisters,
  reconcileSlots,
  registersWarning,
  shortfallFor,
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

const slot = (required, suggested, extra = {}) => ({ franja: "08:00", required, available: 99, suggested, shortfall: 0, status: "ok", ...extra });

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

test("shortfallFor: only cashiers who could ever sit count (min(required, registers) - available)", () => {
  assert.equal(shortfallFor({ required: 12, available: 6 }, 10), 4);
  assert.equal(shortfallFor({ required: 12, available: 6 }, 4), 0, "registers below availability: nothing missing");
  assert.equal(shortfallFor({ required: 12, available: 6 }, null), 6, "unknown registers: plain required - available");
  assert.equal(shortfallFor({ required: 3, available: 5 }, 10), 0);
  assert.equal(shortfallFor({ required: 0, available: 0 }, 10), 0);
  assert.equal(shortfallFor({ required: null, available: 5 }, 10), null);
});

test("capSlots: shortfall and status are recomputed against the registers, required stays", () => {
  const out = capSlots([slot(12, 6, { available: 6, shortfall: 6, status: "shortfall" })], 4);
  assert.deepEqual([out[0].required, out[0].suggested, out[0].shortfall, out[0].status], [12, 4, 0, "ok"]);
  const still = capSlots([slot(12, 6, { available: 6, shortfall: 6, status: "shortfall" })], 10);
  assert.deepEqual([still[0].suggested, still[0].shortfall, still[0].status], [6, 4, "shortfall"]);
  const unknown = capSlots([slot(null, null, { available: 6, shortfall: null, status: "unknown" }), slot(0, 0, { available: 6, shortfall: 0, status: "closed" })], 4);
  assert.deepEqual(unknown.map((s) => [s.shortfall, s.status]), [[null, "unknown"], [0, "closed"]]);
});

const view = (o) => ({ franja: "08:00", required: 3, available: 5, suggested: 3, override: null, final: 3, difference: 0, shortfall: 0, status: "ok", ...o });

test("reconcileSlots: final above the registers is clamped and flagged, override and suggested are not rewritten", () => {
  const [a, b, c] = reconcileSlots([view({ override: 6, final: 6, difference: 3 }), view({ final: 3 }), view({ final: 10, override: 10, difference: 7, suggested: 3 })], 4);
  assert.deepEqual([a.final, a.override, a.difference, a.cappedByRegisters], [4, 6, 1, true]);
  assert.deepEqual([b.final, "cappedByRegisters" in b], [3, false]);
  assert.deepEqual([c.final, c.override, c.cappedByRegisters], [4, 10, true]);
});

test("reconcileSlots: a stale run whose suggestion exceeds the new registers is clamped too (difference follows)", () => {
  const [s] = reconcileSlots([view({ suggested: 6, final: 6, required: 6 })], 4);
  assert.deepEqual([s.suggested, s.final, s.difference, s.cappedByRegisters], [6, 4, -2, true]);
});

test("reconcileSlots: orphan override slots (no suggestion) are clamped; null final stays null; unknown registers is a no-op on final", () => {
  const orphan = { franja: "06:00", required: null, available: null, suggested: null, override: 9, final: 9, difference: null, shortfall: null, status: "unknown" };
  const [o] = reconcileSlots([orphan], 4);
  assert.deepEqual([o.final, o.override, o.difference, o.cappedByRegisters, o.shortfall], [4, 9, null, true, null]);
  const [n] = reconcileSlots([view({ final: null, suggested: null, required: null, difference: null, shortfall: null, status: "unknown" })], 4);
  assert.equal(n.final, null);
  const [k] = reconcileSlots([view({ final: 30, override: 30, difference: 27 })], null);
  assert.deepEqual([k.final, "cappedByRegisters" in k], [30, false]);
});

test("reconcileSlots: shortfall and status follow the current registers on read", () => {
  const [a] = reconcileSlots([view({ required: 12, available: 6, suggested: 6, final: 6, shortfall: 6, status: "shortfall" })], 4);
  assert.deepEqual([a.shortfall, a.status, a.final, a.cappedByRegisters], [0, "ok", 4, true]);
  const [b] = reconcileSlots([view({ required: 12, available: 6, suggested: 6, final: 6, shortfall: 0, status: "ok" })], null);
  assert.deepEqual([b.shortfall, b.status], [6, "shortfall"]);
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
