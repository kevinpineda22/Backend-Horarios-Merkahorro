import test from "node:test";
import assert from "node:assert/strict";

import {
  ABSENCE_TYPES,
  absentDaysByCedula,
  normalizeAbsences,
  parseDateOnly,
} from "../../src/modules/sugerido/domain/absences.js";

const ALL = ABSENCE_TYPES;
const row = (tipo, inicio, fin, extra = {}) => ({
  id: "n1",
  cedula: "100200",
  tipo,
  fecha_inicio: inicio,
  fecha_fin: fin,
  anulada: false,
  ...extra,
});

test("ABSENCE_TYPES lists the 6 novedad types", () => {
  assert.deepEqual([...ABSENCE_TYPES], ["Incapacidades", "Licencias", "Vacaciones", "Permisos", "Estudio", "Día de la Familia"]);
});

test("parseDateOnly accepts YYYY-MM-DD and ISO timestamps, rejects junk", () => {
  assert.equal(parseDateOnly("2026-10-05"), "2026-10-05");
  assert.equal(parseDateOnly(" 2026-10-05T10:20:00Z "), "2026-10-05");
  assert.equal(parseDateOnly("2026-02-30"), null);
  assert.equal(parseDateOnly("garbage"), null);
  assert.equal(parseDateOnly(""), null);
  assert.equal(parseDateOnly(null), null);
  assert.equal(parseDateOnly(true), null);
});

test("normalizeAbsences maps plain inclusive ranges for every type", () => {
  const { absences, warnings } = normalizeAbsences(
    ALL.map((t, i) => row(t, "2026-10-26", "2026-10-28", { id: `n${i}` })),
    ALL
  );
  assert.equal(warnings.length, 0);
  assert.equal(absences.length, 6);
  assert.deepEqual(absences[0], { id: "n0", cedula: "100200", tipo: "Incapacidades", start: "2026-10-26", end: "2026-10-28" });
});

test("a single-day range (inicio = fin) blocks exactly 1 day", () => {
  const { absences, warnings } = normalizeAbsences([row("Permisos", "2026-10-28", "2026-10-28")], ALL);
  assert.equal(warnings.length, 0);
  assert.deepEqual([absences[0].start, absences[0].end], ["2026-10-28", "2026-10-28"]);
  const days = absentDaysByCedula(absences, "2026-10-26").get("100200");
  assert.deepEqual([...days], ["2026-10-28"]);
});

test("timestamps are cut to their date part", () => {
  const { absences } = normalizeAbsences([row("Licencias", "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z")], ALL);
  assert.deepEqual([absences[0].start, absences[0].end], ["2026-10-26", "2026-10-27"]);
});

test("cancelled rows (anulada) are ignored without warnings", () => {
  const { absences, warnings } = normalizeAbsences(
    [row("Licencias", "2026-10-26", "2026-10-27", { anulada: true }), row("Licencias", "2026-10-26", "2026-10-27", { id: "ok" })],
    ALL
  );
  assert.deepEqual(absences.map((a) => a.id), ["ok"]);
  assert.equal(warnings.length, 0);
});

test("anulada must be exactly true to exclude (false/undefined/null stay active)", () => {
  const rows = [false, undefined, null].map((anulada, i) => row("Licencias", "2026-10-26", "2026-10-27", { id: `r${i}`, anulada }));
  assert.equal(normalizeAbsences(rows, ALL).absences.length, 3);
});

test("types outside the blocking set or the known types are ignored without warnings", () => {
  const without = ALL.filter((t) => t !== "Estudio");
  const r = normalizeAbsences([row("Estudio", "2026-10-26", "2026-10-27"), row("Otra", "nope", "nope"), null], [...without, "Otra"]);
  assert.deepEqual(r, { absences: [], warnings: [] });
});

test("non-array input yields an empty result", () => {
  assert.deepEqual(normalizeAbsences(undefined, ALL), { absences: [], warnings: [] });
});

test("cedula is normalized (trim + strip non-digits) per R-b", () => {
  const { absences } = normalizeAbsences(
    [row("Licencias", "2026-10-26", "2026-10-27", { cedula: " 1.234.567 " }), row("Licencias", "2026-10-26", "2026-10-27", { cedula: 7654321 })],
    ALL
  );
  assert.deepEqual(absences.map((a) => a.cedula), ["1234567", "7654321"]);
});

test("warnings: missing cedula, invalid date, end before start", () => {
  const { absences, warnings } = normalizeAbsences(
    [
      row("Licencias", "2026-10-26", "2026-10-27", { id: "ok", cedula: " 123456 " }),
      row("Licencias", "2026-10-26", "2026-10-27", { id: "nocedula", cedula: null }),
      row("Licencias", "2026-10-26", "2026-10-27", { id: "letters", cedula: "abc" }),
      row("Licencias", "nope", "2026-10-27", { id: "badstart" }),
      row("Licencias", "2026-10-26", "2026-02-30", { id: "badend" }),
      row("Licencias", "2026-10-27", "2026-10-26", { id: "reversed" }),
    ],
    ["Licencias"]
  );
  assert.deepEqual(absences.map((a) => a.id), ["ok"]);
  assert.equal(absences[0].cedula, "123456");
  assert.equal(warnings.length, 5);
  for (const [i, id] of ["nocedula", "letters", "badstart", "badend", "reversed"].entries()) {
    assert.match(warnings[i], new RegExp(id));
  }
});

test("absentDaysByCedula clips ranges to the target week (Fri prior week -> Tue)", () => {
  const a = { cedula: "1", start: "2026-10-23", end: "2026-10-27" };
  const map = absentDaysByCedula([a], "2026-10-26");
  assert.deepEqual([...map.get("1")], ["2026-10-26", "2026-10-27"]);
});

test("week boundaries are inclusive on both sides and exclusive outside", () => {
  const w = "2026-10-26"; // Mon .. Sun 2026-11-01
  assert.deepEqual([...absentDaysByCedula([{ cedula: "1", start: "2026-10-20", end: "2026-10-26" }], w).get("1")], ["2026-10-26"]);
  assert.deepEqual([...absentDaysByCedula([{ cedula: "1", start: "2026-11-01", end: "2026-11-09" }], w).get("1")], ["2026-11-01"]);
  assert.equal(absentDaysByCedula([{ cedula: "1", start: "2026-10-20", end: "2026-10-25" }], w).has("1"), false);
  assert.equal(absentDaysByCedula([{ cedula: "1", start: "2026-11-02", end: "2026-11-05" }], w).has("1"), false);
});

test("absence covering the whole week yields 7 days; multiple absences merge per cedula", () => {
  const w = "2026-10-26";
  assert.equal(absentDaysByCedula([{ cedula: "1", start: "2026-10-01", end: "2026-12-01" }], w).get("1").size, 7);
  const m = absentDaysByCedula(
    [
      { cedula: "1", start: "2026-10-26", end: "2026-10-27" },
      { cedula: "1", start: "2026-10-27", end: "2026-10-28" },
    ],
    w
  );
  assert.equal(m.get("1").size, 3);
});
