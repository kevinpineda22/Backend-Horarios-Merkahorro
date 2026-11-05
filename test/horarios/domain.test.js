import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeWeekPayload, timeToMinutes, spanMinutes } from "../../src/modules/horarios/domain/weekPayload.js";
import {
  centeredBreak,
  intervalsOverlap,
  workedMinutesByCedula,
  publishBlockers,
  weekWarnings,
  WEEKLY_LIMIT_MINUTES,
  WARNING_MINUTES,
} from "../../src/modules/horarios/domain/weekRules.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/weekParity.json", import.meta.url), "utf8"));
const W = fx.weekStart; // 2031-01-06, a Monday

// ---------------------------------------------------------------- parity fixture

test("fixture header names its frontend twin", () => {
  assert.match(fx._comment, /weekParity\.json/);
  assert.match(fx._comment, /horarios_merkahorro/);
});

for (const c of fx.overlap) {
  test(`parity overlap: ${c.name}`, () => {
    assert.equal(intervalsOverlap(c.a, c.b), c.overlaps);
    assert.equal(intervalsOverlap(c.b, c.a), c.overlaps);
  });
}

for (const c of fx.centeredBreak) {
  test(`parity centered break: ${c.name}`, () => {
    assert.deepEqual(centeredBreak(c), { breakStart: c.breakStart, breakEnd: c.breakEnd });
  });
}

for (const c of fx.workedMinutes) {
  test(`parity worked minutes: ${c.name}`, () => {
    assert.deepEqual(workedMinutesByCedula(c.rows, W), c.expected);
  });
}

for (const c of fx.blockers) {
  test(`parity blockers: ${c.name}`, () => {
    const got = publishBlockers(c.rows, W, c.scope);
    assert.deepEqual(got, c.expected);
  });
}

for (const c of fx.breakBoundary) {
  test(`parity break boundary: ${c.name}`, () => {
    const row = { cedula: "111", sedeId: "A", tipo: "TRABAJO", ...c };
    const warnings = weekWarnings([row], W, ["111"]).filter((w) => w.code === "BREAK_BOUNDARY_MISMATCH");
    assert.equal(warnings.length > 0, c.mismatch);
    if (c.mismatch) assert.deepEqual(warnings[0], { code: "BREAK_BOUNDARY_MISMATCH", cedula: "111", fecha: c.fecha });
  });
}

// ---------------------------------------------------------------- limits and warnings

test("the 56 h limit is strict and warnings start above 54 h", () => {
  assert.equal(WEEKLY_LIMIT_MINUTES, 3360);
  assert.equal(WARNING_MINUTES, 3240);
});

test("worked time between 54 h and 56 h is a warning, not a blocker", () => {
  // 6 x (08:00-18:10, break 60) = 6 x 550 = 3300 min = 55 h
  const rows = ["06", "07", "08", "09", "10", "11"].map((d) => ({
    cedula: "111", sedeId: "A", fecha: `2031-01-${d}`, tipo: "TRABAJO", startTime: "08:00", endTime: "18:10", breakMinutes: 60,
  }));
  rows.push({ cedula: "111", sedeId: "A", fecha: "2031-01-12", tipo: "DESCANSO", startTime: null, endTime: null, breakMinutes: 0 });
  assert.deepEqual(publishBlockers(rows, W, ["111"]), []);
  const w = weekWarnings(rows, W, ["111"]).find((x) => x.code === "HORAS_EXTRA_SOBRE_12");
  assert.deepEqual(w, { code: "HORAS_EXTRA_SOBRE_12", cedula: "111", workedMinutes: 3300 });
});

test("exactly 54 h raises no overtime warning", () => {
  const rows = ["06", "07", "08", "09", "10", "11"].map((d) => ({
    cedula: "111", sedeId: "A", fecha: `2031-01-${d}`, tipo: "TRABAJO", startTime: "08:00", endTime: "18:00", breakMinutes: 60,
  }));
  assert.equal(weekWarnings(rows, W, ["111"]).filter((x) => x.code === "HORAS_EXTRA_SOBRE_12").length, 0);
});

// ---------------------------------------------------------------- weekPayload

const base = (over = {}) => ({
  cedula: "11111111", fecha: "2031-01-06", tipo: "TRABAJO", startTime: "08:00", endTime: "17:00",
  lunchStart: null, cargo: null, observacion: null, ...over,
});
const run = (shifts, cedulas = ["11111111"]) => normalizeWeekPayload({ weekStart: W, cedulas, shifts });
const rejects = (shifts, cedulas) =>
  assert.throws(() => run(shifts, cedulas), (e) => e.statusCode === 400 && e.code === "INVALID_SHIFTS" && e.expose === true);

test("time helpers", () => {
  assert.equal(timeToMinutes("08:30"), 510);
  assert.equal(timeToMinutes("24:00", { allow24: true }), 1440);
  assert.throws(() => timeToMinutes("24:00"));
  assert.equal(spanMinutes("22:00", "06:00"), 480);
  assert.equal(spanMinutes("08:00", "24:00"), 960);
});

test("TRABAJO without breakMinutes defaults to 60 before validating", () => {
  const [row] = run([base()]);
  assert.equal(row.breakMinutes, 60);
  assert.equal(row.startTime, "08:00");
});

test("explicit breakMinutes 0 is kept", () => {
  assert.equal(run([base({ breakMinutes: 0 })])[0].breakMinutes, 0);
});

test("the default break must still fit the span: a 1 h shift is a 400, never a raw database error", () => {
  rejects([base({ startTime: "08:00", endTime: "09:00" })]);
  rejects([base({ breakMinutes: 540 })]);
  assert.doesNotThrow(() => run([base({ startTime: "08:00", endTime: "09:01" })]));
});

test("midnight crossing and a 24:00 end are accepted; 24:00 start is not", () => {
  assert.equal(run([base({ startTime: "22:00", endTime: "06:00" })])[0].endTime, "06:00");
  assert.equal(run([base({ startTime: "18:00", endTime: "24:00" })])[0].endTime, "24:00");
  rejects([base({ startTime: "24:00", endTime: "06:00" })]);
  rejects([base({ startTime: "08:00", endTime: "08:00" })]);
});

test("malformed or missing times are rejected", () => {
  rejects([base({ startTime: "8:00" })]);
  rejects([base({ endTime: "25:00" })]);
  rejects([base({ endTime: "12:60" })]);
  rejects([base({ endTime: null })]);
  rejects([base({ startTime: undefined })]);
  rejects([base({ lunchStart: "7pm" })]);
});

test("break out of range is rejected", () => {
  rejects([base({ breakMinutes: -1 })]);
  rejects([base({ breakMinutes: 481 })]);
  rejects([base({ breakMinutes: 1.5 })]);
});

test("DESCANSO and COMPENSATORIO are stored without times; supplying times is a 400", () => {
  for (const tipo of ["DESCANSO", "COMPENSATORIO"]) {
    const [row] = run([base({ tipo, startTime: null, endTime: null })]);
    assert.deepEqual([row.startTime, row.endTime, row.lunchStart, row.breakMinutes], [null, null, null, 0]);
    rejects([base({ tipo, startTime: "08:00", endTime: null })]);
    rejects([base({ tipo, startTime: null, endTime: null, lunchStart: "12:00" })]);
    rejects([base({ tipo, startTime: null, endTime: null, breakMinutes: 30 })]);
    assert.equal(run([base({ tipo, startTime: null, endTime: null, breakMinutes: 0 })])[0].breakMinutes, 0);
  }
});

test("unknown tipo, bad cedula, date outside the week, foreign cedula and duplicates are rejected", () => {
  rejects([base({ tipo: "VACACIONES" })]);
  rejects([base({ cedula: "12" })], ["12"]);
  rejects([base({ fecha: "2031-01-05" })]);
  rejects([base({ fecha: "2031-01-13" })]);
  rejects([base({ fecha: "2031-02-30" })]);
  rejects([base({ cedula: "22222222" })]);
  rejects([base(), base({ startTime: "10:00", endTime: "14:00" })]);
  assert.doesNotThrow(() => run([base({ fecha: "2031-01-06" }), base({ fecha: "2031-01-12" })]));
});

test("an empty list is valid and the input is not mutated", () => {
  assert.deepEqual(run([]), []);
  const input = base();
  const copy = structuredClone(input);
  run([input]);
  assert.deepEqual(input, copy);
});

test("cargo and observacion pass through; undefined becomes null", () => {
  const [row] = run([base({ cargo: "Cajero", observacion: undefined })]);
  assert.equal(row.cargo, "Cajero");
  assert.equal(row.observacion, null);
});
