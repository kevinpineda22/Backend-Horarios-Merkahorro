import test from "node:test";
import assert from "node:assert/strict";

const { validateDetalles, DURACIONES_ENFERMEDAD_GENERAL, MODOS_PERMISO_ACADEMICO } = await import(
  "../../src/modules/novedades/domain/novedadDetalles.js"
);

const range = { fechaInicio: "2026-11-03", fechaFin: "2026-11-07" };
const st = (tipo, detalles, extra = {}) => ({ tipo, subtipo: null, ...range, detalles, ...extra });
const eg = (detalles) => st("Incapacidades", detalles, { subtipo: "Enfermedad general" });
const lic = (detalles) => st("Licencias", detalles, { subtipo: "Remunerada" });
const run = (state, opts) => validateDetalles(state, opts);
const issueMap = (state, opts) => Object.fromEntries(run(state, opts).issues.map((i) => [i.path, i.message]));
const paths = (state, opts) => run(state, opts).issues.map((i) => i.path).sort();
const okData = (state, opts) => {
  const r = run(state, opts);
  assert.deepEqual(r.issues, []);
  return r.data;
};

test("constants: the allowed values, NFC", () => {
  assert.deepEqual([...DURACIONES_ENFERMEDAD_GENERAL], ["Mayor a 3 días", "Menor o igual a 3 días"]);
  assert.deepEqual([...MODOS_PERMISO_ACADEMICO], ["parcial", "libre", "redistribuir"]);
  for (const d of DURACIONES_ENFERMEDAD_GENERAL) assert.equal(d, d.normalize("NFC"));
});

// ---- shape -------------------------------------------------------------------------------------
test("detalles must be a plain object (null, arrays and scalars are rejected)", () => {
  for (const bad of [null, [], "x", 3, true]) {
    assert.deepEqual(paths(st("Vacaciones", bad)), ["detalles"], JSON.stringify(bad));
  }
  assert.equal(issueMap(st("Vacaciones", []))["detalles"], "detalles debe ser un objeto");
});

test("unknown keys are rejected with the key in the path (strict), for every tipo", () => {
  assert.deepEqual(issueMap(st("Vacaciones", { extra: 1 })), { "detalles.extra": "Campo no permitido: extra" });
  assert.deepEqual(paths(eg({ duracion: "Mayor a 3 días", otro: 1, mas: 2 })), ["detalles.mas", "detalles.otro"]);
  assert.deepEqual(paths(st("Día de la Familia", { x: 1 })), ["detalles.x"]);
  assert.deepEqual(paths(st("Incapacidades", { duracion: "Mayor a 3 días" }, { subtipo: "ARL" })), ["detalles.duracion"]);
  assert.deepEqual(paths(st("Permisos", { motivo: "m", horas: [{ fecha: "2026-11-03", inicio: "08:00", fin: "09:00", x: 1 }], porHoras: true })), ["detalles.horas.0.x"]);
});

// ---- Incapacidades -----------------------------------------------------------------------------
test("Incapacidades ARL: detalles must be empty", () => {
  assert.deepEqual(okData(st("Incapacidades", {}, { subtipo: "ARL" })), {});
});

test("Enfermedad general: duracion is required and limited to the two labels", () => {
  assert.equal(issueMap(eg({}))["detalles.duracion"], "Debes indicar la duración: Mayor a 3 días o Menor o igual a 3 días.");
  assert.deepEqual(paths(eg({ duracion: "Mayor a 5" })), ["detalles.duracion"]);
  assert.deepEqual(paths(eg({ duracion: null })), ["detalles.duracion"]);
  assert.deepEqual(okData(eg({ duracion: "Mayor a 3 días" })), { duracion: "Mayor a 3 días" });
  assert.deepEqual(okData(eg({ duracion: "Menor o igual a 3 días" })), { duracion: "Menor o igual a 3 días" });
});

test("Enfermedad general: a decomposed (NFD) label is normalized", () => {
  assert.deepEqual(okData(eg({ duracion: "Mayor a 3 días".normalize("NFD") })), { duracion: "Mayor a 3 días" });
});

// ---- Licencias ---------------------------------------------------------------------------------
test("Licencias: dias (integer > 0) and motivo are required", () => {
  const m = issueMap(lic({}));
  assert.equal(m["detalles.dias"], "Los días de la licencia deben ser un número entero mayor a 0");
  assert.equal(m["detalles.motivo"], "El motivo de la licencia es obligatorio");
  for (const dias of [0, -1, 1.5, "3", null]) assert.deepEqual(paths(lic({ dias, motivo: "m" })), ["detalles.dias"], String(dias));
  assert.deepEqual(paths(lic({ dias: 2, motivo: "   " })), ["detalles.motivo"]);
});

test("Licencias: motivo <= 1000, liderAprueba <= 120, fechaAprobacion a real date; optionals may be null/empty", () => {
  assert.deepEqual(paths(lic({ dias: 2, motivo: "x".repeat(1001) })), ["detalles.motivo"]);
  assert.deepEqual(paths(lic({ dias: 2, motivo: "x".repeat(1000) })), []);
  assert.deepEqual(paths(lic({ dias: 2, motivo: "m", liderAprueba: "x".repeat(121) })), ["detalles.liderAprueba"]);
  assert.deepEqual(paths(lic({ dias: 2, motivo: "m", fechaAprobacion: "2026-02-30" })), ["detalles.fechaAprobacion"]);
  assert.deepEqual(paths(lic({ dias: 2, motivo: "m", fechaAprobacion: "03/11/2026" })), ["detalles.fechaAprobacion"]);
  assert.deepEqual(okData(lic({ dias: 2, motivo: "  Calamidad  ", liderAprueba: " Ana ", fechaAprobacion: "2026-11-02" })), {
    dias: 2,
    motivo: "Calamidad",
    liderAprueba: "Ana",
    fechaAprobacion: "2026-11-02",
  });
  assert.deepEqual(okData(lic({ dias: 2, motivo: "m", liderAprueba: null, fechaAprobacion: "" })), { dias: 2, motivo: "m" });
});

// ---- Permisos ----------------------------------------------------------------------------------
test("Permisos: motivo required; porHoras optional boolean", () => {
  assert.equal(issueMap(st("Permisos", {}))["detalles.motivo"], "El motivo del permiso es obligatorio");
  assert.deepEqual(okData(st("Permisos", { motivo: "Cita médica" })), { motivo: "Cita médica" });
  assert.deepEqual(okData(st("Permisos", { motivo: "m", porHoras: false })), { motivo: "m", porHoras: false });
  assert.deepEqual(paths(st("Permisos", { motivo: "m", porHoras: "si" })), ["detalles.porHoras"]);
  assert.deepEqual(paths(st("Permisos", { motivo: "x".repeat(1001) })), ["detalles.motivo"]);
});

const hora = (o = {}) => ({ fecha: "2026-11-03", inicio: "08:00", fin: "10:30", ...o });
const perm = (extra) => st("Permisos", { motivo: "m", porHoras: true, ...extra });

test("Permisos por horas: horas must be a non-empty array of {fecha, inicio, fin}", () => {
  assert.equal(issueMap(perm({}))["detalles.horas"], "Debes agregar al menos un día con su rango de horas");
  assert.deepEqual(paths(perm({ horas: [] })), ["detalles.horas"]);
  assert.deepEqual(paths(perm({ horas: "x" })), ["detalles.horas"]);
  const data = okData(perm({ horas: [hora(), hora({ fecha: "2026-11-04", inicio: "14:00", fin: "15:00" })] }));
  assert.equal(data.horas.length, 2);
  assert.equal(data.porHoras, true);
});

test("Permisos por horas: at most 62 entries", () => {
  const many = (n) => Array.from({ length: n }, () => hora());
  assert.deepEqual(paths(perm({ horas: many(63) })), ["detalles.horas"]);
  assert.deepEqual(paths(perm({ horas: many(62) })), []);
});

test("Permisos por horas: HH:MM format, fin > inicio, fecha inside fechaInicio..fechaFin", () => {
  assert.deepEqual(paths(perm({ horas: [hora({ inicio: "8:00" })] })), ["detalles.horas.0.inicio"]);
  assert.deepEqual(paths(perm({ horas: [hora({ fin: "24:00" })] })), ["detalles.horas.0.fin"]);
  assert.deepEqual(paths(perm({ horas: [hora({ inicio: "09:60" })] })), ["detalles.horas.0.inicio"]);
  assert.equal(issueMap(perm({ horas: [hora({ inicio: "10:00", fin: "10:00" })] }))["detalles.horas.0.fin"], "La hora fin debe ser posterior a la hora inicio");
  assert.deepEqual(paths(perm({ horas: [hora({ inicio: "11:00", fin: "10:00" })] })), ["detalles.horas.0.fin"]);
  assert.equal(issueMap(perm({ horas: [hora({ fecha: "2026-11-08" })] }))["detalles.horas.0.fecha"], "La fecha debe estar dentro del rango de la novedad");
  assert.deepEqual(paths(perm({ horas: [hora(), hora({ fecha: "2026-11-02" })] })), ["detalles.horas.1.fecha"]);
  assert.deepEqual(paths(perm({ horas: [hora({ fecha: "2026-11-03" }), hora({ fecha: "2026-11-07" })] })), [], "range edges are inclusive");
  assert.deepEqual(paths(perm({ horas: [hora({ fecha: "2026-02-30" })] })), ["detalles.horas.0.fecha"]);
});

test("Permisos: horas without porHoras = true are rejected; porHoras false drops an empty list", () => {
  assert.deepEqual(paths(st("Permisos", { motivo: "m", horas: [hora()] })), ["detalles.horas"]);
  assert.deepEqual(paths(st("Permisos", { motivo: "m", porHoras: false, horas: [hora()] })), ["detalles.horas"]);
  assert.deepEqual(okData(st("Permisos", { motivo: "m", porHoras: false, horas: [] })), { motivo: "m", porHoras: false });
});

// ---- Permisos académicos -----------------------------------------------------------------------
const acad = (extra, dates = range) =>
  st("Permisos académicos", { modo: "libre", dias: [{ fecha: range.fechaInicio }, { fecha: range.fechaFin }], detalle: "Examen final", ...extra }, dates);

test("Permisos académicos: modo, dias and detalle are required", () => {
  const m = issueMap(st("Permisos académicos", {}));
  assert.equal(m["detalles.modo"], "Debes indicar el modo: parcial, libre o redistribuir");
  assert.equal(m["detalles.dias"], "Debes seleccionar al menos un día");
  assert.equal(m["detalles.detalle"], "El detalle del permiso académico es obligatorio");
  assert.deepEqual(paths(acad({ modo: "otro" })), ["detalles.modo"]);
  assert.deepEqual(paths(acad({ dias: [] })), ["detalles.dias"]);
  assert.deepEqual(paths(acad({ detalle: "  " })), ["detalles.detalle"]);
  assert.deepEqual(paths(acad({ detalle: "x".repeat(1001) })), ["detalles.detalle"]);
});

test("Permisos académicos libre / redistribuir: no schedule; fechaInicio/fechaFin equal the first and last day", () => {
  for (const modo of MODOS_PERMISO_ACADEMICO.filter((x) => x !== "parcial")) {
    const data = okData(acad({ modo }));
    assert.equal(data.modo, modo);
  }
  const ok = okData(acad({ dias: [{ fecha: "2026-11-07" }, { fecha: "2026-11-03" }, { fecha: "2026-11-05" }] }));
  assert.deepEqual(ok.dias.map((d) => d.fecha), ["2026-11-03", "2026-11-05", "2026-11-07"], "days are stored sorted");
  assert.deepEqual(issueMap(acad({}, { fechaInicio: "2026-11-02", fechaFin: "2026-11-07" })), {
    fechaInicio: "fechaInicio debe ser el primer día seleccionado (2026-11-03)",
  });
  assert.deepEqual(issueMap(acad({}, { fechaInicio: "2026-11-03", fechaFin: "2026-11-09" })), {
    fechaFin: "fechaFin debe ser el último día seleccionado (2026-11-07)",
  });
});

test("Permisos académicos: days are real, unique dates", () => {
  assert.deepEqual(paths(acad({ dias: [{ fecha: "2026-11-03" }, { fecha: "2026-11-03" }, { fecha: "2026-11-07" }] })), ["detalles.dias.1.fecha"]);
  assert.deepEqual(paths(acad({ dias: [{ fecha: "2026-02-30" }] })), ["detalles.dias.0.fecha"]);
  assert.deepEqual(paths(acad({ dias: [{ fecha: "2026-11-03", extra: 1 }, { fecha: "2026-11-07" }] })), ["detalles.dias.0.extra"]);
  const many = Array.from({ length: 63 }, (_, i) => ({ fecha: `2026-12-${String((i % 28) + 1).padStart(2, "0")}` }));
  assert.ok(paths(acad({ dias: many })).includes("detalles.dias"));
});

test("Permisos académicos parcial: inicio/fin required (HH:MM, fin > inicio); other modes reject them", () => {
  assert.deepEqual(paths(acad({ modo: "parcial" })), ["detalles.fin", "detalles.inicio"]);
  assert.equal(issueMap(acad({ modo: "parcial" }))["detalles.inicio"], "La hora de inicio es obligatoria para el modo parcial");
  assert.deepEqual(paths(acad({ modo: "parcial", inicio: "9:00", fin: "10:00" })), ["detalles.inicio"]);
  assert.deepEqual(paths(acad({ modo: "parcial", inicio: "10:00", fin: "10:00" })), ["detalles.fin"]);
  assert.deepEqual(paths(acad({ modo: "parcial", inicio: "11:00", fin: "10:00" })), ["detalles.fin"]);
  const data = okData(acad({ modo: "parcial", inicio: "08:00", fin: "10:00" }));
  assert.equal(data.inicio, "08:00");
  assert.equal(data.fin, "10:00");
  assert.deepEqual(paths(acad({ modo: "libre", inicio: "08:00", fin: "10:00" })), ["detalles.fin", "detalles.inicio"]);
});

// ---- Vacaciones --------------------------------------------------------------------------------
test("Vacaciones: periodo (4-digit year) and fechaRegreso (>= fechaFin) are optional", () => {
  assert.deepEqual(okData(st("Vacaciones", {})), {});
  assert.deepEqual(okData(st("Vacaciones", { periodo: "2026", fechaRegreso: "2026-11-07" })), { periodo: "2026", fechaRegreso: "2026-11-07" });
  assert.deepEqual(okData(st("Vacaciones", { periodo: 2026 })), { periodo: "2026" }, "a numeric year is stored as text");
  assert.deepEqual(okData(st("Vacaciones", { periodo: null, fechaRegreso: null })), {});
  for (const periodo of ["26", "20266", "abcd", 12345, 2026.5]) assert.deepEqual(paths(st("Vacaciones", { periodo })), ["detalles.periodo"], String(periodo));
  assert.equal(issueMap(st("Vacaciones", { fechaRegreso: "2026-11-06" }))["detalles.fechaRegreso"], "La fecha de regreso no puede ser anterior a fechaFin");
  assert.deepEqual(paths(st("Vacaciones", { fechaRegreso: "2026-02-30" })), ["detalles.fechaRegreso"]);
});

test("Día de la Familia only accepts an empty detalles", () => {
  assert.deepEqual(okData(st("Día de la Familia", {})), {});
});

// ---- lenient mode (legacy rows) ----------------------------------------------------------------
test("lenient mode: required fields are not enforced, but present values are still validated", () => {
  const lenient = { lenient: true };
  assert.deepEqual(paths(st("Permisos", {}), lenient), []);
  assert.deepEqual(paths(lic({}), lenient), []);
  assert.deepEqual(paths(eg({}), lenient), []);
  assert.deepEqual(paths(st("Permisos académicos", {}), lenient), []);
  assert.deepEqual(paths(lic({ dias: 0 }), lenient), ["detalles.dias"]);
  assert.deepEqual(paths(perm({ horas: [hora({ fecha: "2026-12-30" })] }), lenient), ["detalles.horas.0.fecha"]);
  assert.deepEqual(paths(acad({}, { fechaInicio: "2026-11-02", fechaFin: "2026-11-07" }), lenient), ["fechaInicio"]);
  assert.deepEqual(paths(st("Vacaciones", { fechaRegreso: "2026-11-01" }), lenient), ["detalles.fechaRegreso"]);
});

test("validateDetalles does not mutate its input", () => {
  const input = { motivo: "  m  ", porHoras: true, horas: [hora()] };
  const copy = structuredClone(input);
  validateDetalles(st("Permisos", input));
  assert.deepEqual(input, copy);
});
