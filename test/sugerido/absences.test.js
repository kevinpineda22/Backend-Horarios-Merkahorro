import test from "node:test";
import assert from "node:assert/strict";

import {
  ABSENCE_TYPES,
  absentDaysByCedula,
  inferBlockingEnd,
  normalizeAbsences,
  normalizeBlockingObservation,
  parseDateOnly,
} from "../../src/modules/sugerido/domain/absences.js";

const ALL = ABSENCE_TYPES;
const obs = (tipo, details = {}, extra = {}) => ({ id: 1, cedula: "100", tipo_novedad: tipo, details, ...extra });
const norm = (o, types = ALL) => normalizeBlockingObservation(o, types);

test("ABSENCE_TYPES lists the 6 legacy types", () => {
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

test("each of the 6 types resolves its own date keys", () => {
  assert.deepEqual(
    pick(norm(obs("Incapacidades", { fecha_inicio: "2026-10-26", fecha_fin: "2026-10-28" }))),
    ["2026-10-26", "2026-10-28"]
  );
  assert.deepEqual(
    pick(norm(obs("Licencias", { fecha_inicio: "2026-10-26", fecha_termino: "2026-10-30" }))),
    ["2026-10-26", "2026-10-30"]
  );
  assert.deepEqual(
    pick(norm(obs("Vacaciones", { fecha_inicio_vacaciones: "2026-10-26", fecha_fin_vacaciones: "2026-11-06" }))),
    ["2026-10-26", "2026-11-06"]
  );
  assert.deepEqual(
    pick(norm(obs("Permisos", { fecha_inicio: "2026-10-26", fecha_fin: "2026-10-27" }))),
    ["2026-10-26", "2026-10-27"]
  );
  assert.deepEqual(
    pick(norm(obs("Estudio", { fecha_inicio: "2026-10-26", fecha_fin: "2026-10-27" }))),
    ["2026-10-26", "2026-10-27"]
  );
  assert.deepEqual(
    pick(norm(obs("Día de la Familia", { fecha_propuesta_dia_familia: "2026-10-30" }))),
    ["2026-10-30", "2026-10-30"]
  );
});

function pick(a) {
  return [a.start, a.end];
}

test("Vacaciones without end uses return date minus one day", () => {
  const a = norm(obs("Vacaciones", { fecha_inicio_vacaciones: "2026-10-20", fecha_regreso_vacaciones: "2026-10-27" }));
  assert.deepEqual(pick(a), ["2026-10-20", "2026-10-26"]);
});

test("Estudio with dias_estudio spans first to last sorted date", () => {
  const a = norm(obs("Estudio", { dias_estudio: [{ fecha: "2026-10-29" }, { fecha: "2026-10-26" }, { fecha: "2026-10-27" }] }));
  assert.deepEqual(pick(a), ["2026-10-26", "2026-10-29"]);
});

test("falls back to fecha_novedad when details has no start", () => {
  const a = norm(obs("Permisos", {}, { fecha_novedad: "2026-10-28" }));
  assert.deepEqual(pick(a), ["2026-10-28", "2026-10-28"]);
});

test("accepts legacy `tipo` key too", () => {
  const a = norm({ id: 2, cedula: "1", tipo: "Licencias", details: { fecha_inicio: "2026-10-26" } });
  assert.equal(a.tipo, "Licencias");
});

test("inferBlockingEnd fallbacks: valid end wins, then regreso, duration, diasIncapacidad, start", () => {
  assert.equal(inferBlockingEnd("Licencias", "2026-10-26", "2026-10-30", {}), "2026-10-30");
  assert.equal(inferBlockingEnd("Licencias", "2026-10-26", "2026-10-26", {}), "2026-10-26"); // end == start is valid
  assert.equal(inferBlockingEnd("Vacaciones", "2026-10-26", null, { fecha_regreso_vacaciones: "2026-11-02" }), "2026-11-01");
  assert.equal(inferBlockingEnd("Licencias", "2026-10-26", null, { duracion_dias: 3 }), "2026-10-28");
  assert.equal(inferBlockingEnd("Incapacidades", "2026-10-26", null, { diasIncapacidad: "5 días" }), "2026-10-30");
  assert.equal(inferBlockingEnd("Incapacidades", "2026-10-26", null, { diasIncapacidad: 2 }), "2026-10-27");
  assert.equal(inferBlockingEnd("Licencias", "2026-10-26", "2026-10-20", {}), "2026-10-26"); // end before start
  assert.equal(inferBlockingEnd("Licencias", "2026-10-26", null, { duracion_dias: 0 }), "2026-10-26");
});

test("Incapacidades without any end key uses diasIncapacidad", () => {
  const a = norm(obs("Incapacidades", { diasIncapacidad: "3 días" }, { fecha_novedad: "2026-10-26" }));
  assert.deepEqual(pick(a), ["2026-10-26", "2026-10-28"]);
});

test("types outside the blocking set or the 6 legacy types are ignored", () => {
  const without = ALL.filter((t) => t !== "Estudio");
  assert.equal(norm(obs("Estudio", { fecha_inicio: "2026-10-26" }), without), null);
  assert.equal(norm(obs("Otra", { fecha_inicio: "2026-10-26" }), [...ALL, "Otra"]), null);
  assert.equal(norm(null), null);
});

test("normalizeAbsences returns warnings for unparseable or cedula-less blocking rows", () => {
  const { absences, warnings } = normalizeAbsences(
    [
      obs("Licencias", { fecha_inicio: "2026-10-26" }, { id: 10, cedula: " 123 " }),
      obs("Licencias", { fecha_inicio: "nope" }, { id: 11 }),
      obs("Licencias", { fecha_inicio: "2026-10-26" }, { id: 12, cedula: null }),
      obs("Estudio", { fecha_inicio: "nope" }, { id: 13 }), // not blocking: no warning
    ],
    ["Licencias"]
  );
  assert.equal(absences.length, 1);
  assert.equal(absences[0].cedula, "123");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /11/);
  assert.match(warnings[1], /12/);
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

test("Incapacidades with fecha_inicio and no fecha_fin uses diasIncapacidad (5 blocked days)", () => {
  const a = norm(obs("Incapacidades", { fecha_inicio: "2026-10-26", diasIncapacidad: 5 }));
  assert.deepEqual(pick(a), ["2026-10-26", "2026-10-30"]);
});

test("Incapacidades: explicit fecha_fin wins over diasIncapacidad; neither -> 1 day", () => {
  const explicit = norm(obs("Incapacidades", { fecha_inicio: "2026-10-26", fecha_fin: "2026-10-27", diasIncapacidad: 5 }));
  assert.deepEqual(pick(explicit), ["2026-10-26", "2026-10-27"]);
  const none = norm(obs("Incapacidades", { fecha_inicio: "2026-10-26" }));
  assert.deepEqual(pick(none), ["2026-10-26", "2026-10-26"]);
});

test("Licencias with fecha_inicio and no fecha_termino uses duracion_dias; explicit end wins", () => {
  const dur = norm(obs("Licencias", { fecha_inicio: "2026-10-26", duracion_dias: 3 }));
  assert.deepEqual(pick(dur), ["2026-10-26", "2026-10-28"]);
  const explicit = norm(obs("Licencias", { fecha_inicio: "2026-10-26", fecha_termino: "2026-10-27", duracion_dias: 3 }));
  assert.deepEqual(pick(explicit), ["2026-10-26", "2026-10-27"]);
  const none = norm(obs("Licencias", { fecha_inicio: "2026-10-26" }));
  assert.deepEqual(pick(none), ["2026-10-26", "2026-10-26"]);
});
