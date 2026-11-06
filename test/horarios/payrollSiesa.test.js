import test from "node:test";
import assert from "node:assert/strict";
import { SIESA_HEADERS, siesaTuples, variation } from "../../src/modules/horarios/domain/payrollRules.js";

const wk = (weekStart, { extras = 0, nocturnas = 0, dominicales = 0, festivos = 0 } = {}) => ({
  weekStart,
  extras,
  nocturnas,
  dominicales,
  festivos,
});
const line = (cedula, siesaCode, weeks) => ({ cedula, siesaCode, weeks });
const blank = (n) => Array(n).fill("");

test("SIESA_HEADERS has the 20 columns of the old export", () => {
  assert.equal(SIESA_HEADERS.length, 20);
  assert.equal(SIESA_HEADERS[0], "CODIGO DEL EMPLEADO (Obligatorio)");
  assert.equal(SIESA_HEADERS[1], "SUCURSAL (Obligatorio)");
  assert.equal(SIESA_HEADERS[2], "CODIGO DEL CONCEPTO (Obligatorio)");
  assert.equal(SIESA_HEADERS[19], "NOTAS (No obligatorio)");
});

test("groups weekly values per concept and keeps the concept order 103, 105, 108, 113", () => {
  const rows = siesaTuples([
    line("1012345678", "3", [
      wk("2026-08-31", { dominicales: 6, extras: 1, nocturnas: 2, festivos: 8 }),
      wk("2026-09-07", { dominicales: 2, extras: 1 }),
    ]),
  ]);
  assert.deepEqual(
    rows.map((r) => [r[2], r[6]]),
    [[103, 8], [105, 8], [108, 2], [113, 2]],
  );
  assert.deepEqual(rows[0], [1012345678, "003", 103, "", "", "", 8, 0, ...blank(12)]);
  assert.equal(rows[0].length, 20);
});

test("skips concepts with zero hours and employees with nothing to export", () => {
  const rows = siesaTuples([
    line("1012345678", "003", [wk("2026-08-31", { dominicales: 6, extras: 2 })]),
    line("1098765432", "011", [wk("2026-08-31")]),
  ]);
  assert.deepEqual(rows.map((r) => [r[0], r[2]]), [[1012345678, 103], [1012345678, 108]]);
});

test("cedula is a Number up to 15 digits, text otherwise; branch is padded to 3", () => {
  const rows = siesaTuples([
    line("123456789012345", "7", [wk("2026-08-31", { extras: 1 })]),
    line("1234567890123456", "11", [wk("2026-08-31", { extras: 1 })]),
    line("CE-123", "0123", [wk("2026-08-31", { extras: 1 })]),
  ]);
  assert.equal(rows[0][0], 123456789012345);
  assert.equal(rows[0][1], "007");
  assert.equal(rows[1][0], "1234567890123456");
  assert.equal(rows[1][1], "011");
  assert.equal(rows[2][0], "CE-123");
  assert.equal(rows[2][1], "0123");
});

test("the same cedula and branch on two lines merge into one row per concept", () => {
  const rows = siesaTuples([
    line("1012345678", "003", [wk("2026-08-31", { extras: 0.33 })]),
    line("1012345678", "003", [wk("2026-09-07", { extras: 0.33 })]),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][6], 0.66);
});

test("the same cedula with two branches keeps separate rows", () => {
  const rows = siesaTuples([
    line("1012345678", "003", [wk("2026-08-31", { extras: 1 })]),
    line("1012345678", "011", [wk("2026-08-31", { extras: 2 })]),
  ]);
  assert.deepEqual(rows.map((r) => [r[1], r[6]]), [["003", 1], ["011", 2]]);
});

test("variation: no previous cut means no comparison", () => {
  assert.deepEqual(variation(5, null), { current: 5, previous: null, delta: null, percent: null, kind: "none", review: false });
  assert.equal(variation(5, undefined).kind, "none");
});

test("variation: review needs |delta| >= 4 and |percent| >= 25", () => {
  assert.deepEqual(variation(14, 10), { current: 14, previous: 10, delta: 4, percent: 40, kind: "up", review: true });
  const boundary = variation(20, 16);
  assert.equal(boundary.delta, 4);
  assert.equal(boundary.percent, 25);
  assert.equal(boundary.review, true);
  assert.equal(variation(13.9, 10).review, false); // delta 3.9
  const small = variation(44, 40); // percent 10
  assert.equal(small.percent, 10);
  assert.equal(small.review, false);
  assert.equal(variation(6, 10).kind, "down");
  assert.equal(variation(6, 10).review, true); // delta -4, percent -40
  assert.equal(variation(10, 10).kind, "flat");
});

test("variation: previous zero is new when the current is positive", () => {
  const four = variation(4, 0);
  assert.equal(four.kind, "new");
  assert.equal(four.percent, null);
  assert.equal(four.review, true);
  assert.equal(variation(3.99, 0).review, false);
  assert.equal(variation(3.99, 0).kind, "new");
  assert.deepEqual(variation(0, 0), { current: 0, previous: 0, delta: 0, percent: 0, kind: "flat", review: false });
});

test("variation rounds its inputs before comparing", () => {
  const v = variation(3.9999999, 0);
  assert.equal(v.current, 4);
  assert.equal(v.review, true);
});
