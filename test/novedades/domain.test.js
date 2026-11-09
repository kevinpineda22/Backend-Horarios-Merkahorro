import test from "node:test";
import assert from "node:assert/strict";

const { NOVEDAD_TYPES } = await import("../../src/modules/novedades/domain/novedadTypes.js");
const { NOVEDAD_CREATABLE_TYPES, SUBTIPOS_BY_TIPO, validateNovedadRules } = await import(
  "../../src/modules/novedades/domain/novedadTypes.js"
);
const { rangesOverlap, toNovedadDto } = await import("../../src/modules/novedades/domain/ranges.js");
const { ABSENCE_TYPES } = await import("../../src/modules/sugerido/domain/absences.js");

test("NOVEDAD_TYPES: stored labels (NFC), frozen; Estudio was renamed", () => {
  assert.deepEqual([...NOVEDAD_TYPES], [
    "Incapacidades",
    "Licencias",
    "Vacaciones",
    "Permisos",
    "Permisos académicos",
    "Día de la Familia",
  ]);
  for (const t of NOVEDAD_TYPES) assert.equal(t, t.normalize("NFC"));
  assert.ok(Object.isFrozen(NOVEDAD_TYPES));
  assert.ok(!NOVEDAD_TYPES.includes("Estudio"));
});

test("NOVEDAD_CREATABLE_TYPES: the 5 current types; Día de la Familia is read-only history", () => {
  assert.deepEqual([...NOVEDAD_CREATABLE_TYPES], [
    "Incapacidades",
    "Licencias",
    "Vacaciones",
    "Permisos",
    "Permisos académicos",
  ]);
  assert.ok(Object.isFrozen(NOVEDAD_CREATABLE_TYPES));
});

test("SUBTIPOS_BY_TIPO: only Incapacidades and Licencias have subtypes", () => {
  assert.deepEqual(SUBTIPOS_BY_TIPO.Incapacidades, ["ARL", "Enfermedad general"]);
  assert.deepEqual(SUBTIPOS_BY_TIPO.Licencias, ["Remunerada", "No remunerada"]);
  assert.deepEqual(Object.keys(SUBTIPOS_BY_TIPO), ["Incapacidades", "Licencias"]);
});

const ARL_FILES = { adjuntoPath: "2026/11/a-adjunto.pdf", firmaPath: "2026/11/a-firma.png", historiaPath: "2026/11/a-historia.pdf" };
const paths = (issues) => issues.map((i) => i.path).sort();
const OBS = { observacion: "Reposo médico" };
const EG_SHORT = { tipo: "Incapacidades", subtipo: "Enfermedad general", detalles: { duracion: "Menor o igual a 3 días" }, ...OBS };
const EG_LONG = { tipo: "Incapacidades", subtipo: "Enfermedad general", detalles: { duracion: "Mayor a 3 días" }, ...OBS };
const ARL = { tipo: "Incapacidades", subtipo: "ARL", ...OBS };

test("validateNovedadRules: Incapacidades requires ARL or Enfermedad general", () => {
  assert.deepEqual(paths(validateNovedadRules({ tipo: "Incapacidades", subtipo: null, ...OBS, adjuntoPath: "a" })), ["subtipo"]);
  assert.deepEqual(paths(validateNovedadRules({ tipo: "Incapacidades", subtipo: "Remunerada", ...OBS, adjuntoPath: "a" })), ["subtipo"]);
  assert.deepEqual(validateNovedadRules({ ...EG_SHORT, adjuntoPath: ARL_FILES.adjuntoPath }), []);
  assert.deepEqual(validateNovedadRules({ ...ARL, ...ARL_FILES }), []);
});

test("validateNovedadRules: Licencias requires Remunerada or No remunerada", () => {
  assert.deepEqual(paths(validateNovedadRules({ tipo: "Licencias", subtipo: undefined })), ["subtipo"]);
  assert.deepEqual(paths(validateNovedadRules({ tipo: "Licencias", subtipo: "ARL" })), ["subtipo"]);
  assert.deepEqual(validateNovedadRules({ tipo: "Licencias", subtipo: "Remunerada" }), []);
  assert.deepEqual(validateNovedadRules({ tipo: "Licencias", subtipo: "No remunerada" }), []);
});

test("validateNovedadRules: other types reject any subtipo", () => {
  for (const tipo of ["Vacaciones", "Permisos", "Permisos académicos"]) {
    assert.deepEqual(validateNovedadRules({ tipo, subtipo: null }), []);
    assert.deepEqual(paths(validateNovedadRules({ tipo, subtipo: "ARL" })), ["subtipo"]);
  }
});

test("validateNovedadRules: ARL needs adjunto, firma and historia; the observation is mandatory", () => {
  assert.deepEqual(paths(validateNovedadRules({ ...ARL })), ["adjuntoPath", "firmaPath", "historiaPath"]);
  assert.deepEqual(paths(validateNovedadRules({ ...ARL, adjuntoPath: ARL_FILES.adjuntoPath, historiaPath: ARL_FILES.historiaPath })), ["firmaPath"]);
  assert.deepEqual(paths(validateNovedadRules({ ...ARL, firmaPath: ARL_FILES.firmaPath, historiaPath: ARL_FILES.historiaPath })), ["adjuntoPath"]);
  assert.deepEqual(paths(validateNovedadRules({ ...ARL, ...ARL_FILES, observacion: null })), ["observacion"]);
  assert.deepEqual(paths(validateNovedadRules({ ...ARL, ...ARL_FILES, observacion: "   " })), ["observacion"]);
  for (const i of validateNovedadRules({ ...ARL })) assert.ok(i.message.length > 10);
});

test("validateNovedadRules: Enfermedad general always needs the incapacidad; the historia depends on the duration", () => {
  assert.deepEqual(paths(validateNovedadRules({ ...EG_SHORT })), ["adjuntoPath"]);
  assert.deepEqual(validateNovedadRules({ ...EG_SHORT, adjuntoPath: ARL_FILES.adjuntoPath }), []);
  assert.deepEqual(validateNovedadRules({ ...EG_SHORT, adjuntoPath: ARL_FILES.adjuntoPath, historiaPath: ARL_FILES.historiaPath }), [], "historia is optional for <= 3 days");
  assert.deepEqual(paths(validateNovedadRules({ ...EG_LONG, adjuntoPath: ARL_FILES.adjuntoPath })), ["historiaPath"]);
  assert.deepEqual(validateNovedadRules({ ...EG_LONG, adjuntoPath: ARL_FILES.adjuntoPath, historiaPath: ARL_FILES.historiaPath }), []);
  assert.deepEqual(paths(validateNovedadRules({ ...EG_SHORT, observacion: "", adjuntoPath: ARL_FILES.adjuntoPath })), ["observacion"]);
  assert.deepEqual(paths(validateNovedadRules({ ...EG_SHORT, ...ARL_FILES })), ["firmaPath"], "only ARL signs");
});

test("validateNovedadRules: files are only allowed where they belong", () => {
  const p = (state) => paths(validateNovedadRules(state));
  assert.deepEqual(p({ tipo: "Vacaciones", subtipo: null, adjuntoPath: "a" }), ["adjuntoPath"]);
  assert.deepEqual(p({ tipo: "Licencias", subtipo: "Remunerada", historiaPath: "h", firmaPath: "f" }), ["firmaPath", "historiaPath"]);
  assert.deepEqual(p({ tipo: "Permisos", subtipo: null, historiaPath: "h", adjuntoPath: "a" }), ["adjuntoPath", "historiaPath"]);
  assert.deepEqual(p({ tipo: "Permisos", subtipo: null, soportePath: "s" }), []);
  assert.deepEqual(p({ tipo: "Permisos académicos", subtipo: null, soportePath: "s" }), []);
  assert.deepEqual(p({ tipo: "Vacaciones", subtipo: null, soportePath: "s" }), ["soportePath"]);
  assert.deepEqual(p({ ...EG_SHORT, adjuntoPath: "a", soportePath: "s" }), ["soportePath"]);
});

test("validateNovedadRules with `touched`: only the touched fields are judged (legacy rows stay editable)", () => {
  const legacyEg = { tipo: "Incapacidades", subtipo: null, observacion: null, detalles: {} };
  const touched = (...k) => ({ touched: new Set(k) });
  assert.deepEqual(validateNovedadRules(legacyEg, touched()), [], "nothing touched");
  assert.deepEqual(validateNovedadRules(legacyEg, touched("observacion")).map((i) => i.path), ["observacion"], "cannot be cleared");
  assert.deepEqual(validateNovedadRules({ ...legacyEg, observacion: "ok" }, touched("observacion")), []);
  // A legacy ARL row (adjunto + firma, no historia, no detalles) can replace its signature without being forced to add the historia.
  const legacyArl = { ...ARL, adjuntoPath: "a", firmaPath: "f2" };
  assert.deepEqual(validateNovedadRules(legacyArl, touched("firmaPath")), []);
  // ...but a required file that the patch explicitly empties is rejected.
  assert.deepEqual(paths(validateNovedadRules({ ...legacyArl, adjuntoPath: null }, touched("adjuntoPath"))), ["adjuntoPath"]);
  assert.deepEqual(paths(validateNovedadRules({ ...legacyArl, firmaPath: null }, touched("firmaPath"))), ["firmaPath"]);
  // Forbidden files are rejected when touched.
  assert.deepEqual(paths(validateNovedadRules({ tipo: "Vacaciones", subtipo: null, soportePath: "s" }, touched("soportePath"))), ["soportePath"]);
  // Touching a file runs the subtipo rule (006 behavior).
  assert.deepEqual(paths(validateNovedadRules({ tipo: "Incapacidades", subtipo: null, adjuntoPath: "a" }, touched("adjuntoPath"))), ["subtipo"]);
});

test("ABSENCE_TYPES is the same list as NOVEDAD_TYPES (single source)", () => {
  assert.equal(ABSENCE_TYPES, NOVEDAD_TYPES);
});

test("rangesOverlap: inclusive boundaries", () => {
  const r = ["2026-11-10", "2026-11-20"];
  assert.equal(rangesOverlap(...r, "2026-11-20", "2026-11-25"), true); // touches at end
  assert.equal(rangesOverlap(...r, "2026-11-01", "2026-11-10"), true); // touches at start
  assert.equal(rangesOverlap(...r, "2026-11-21", "2026-11-25"), false); // one day after
  assert.equal(rangesOverlap(...r, "2026-11-01", "2026-11-09"), false); // one day before
  assert.equal(rangesOverlap(...r, "2026-11-12", "2026-11-13"), true); // contained
  assert.equal(rangesOverlap(...r, "2026-11-01", "2026-11-30"), true); // containing
  assert.equal(rangesOverlap("2026-11-10", "2026-11-10", "2026-11-10", "2026-11-10"), true);
});

test("toNovedadDto maps snake_case rows to camelCase and nulls missing fields", () => {
  const row = {
    id: "u1",
    cedula: "123456",
    tipo: "Permisos",
    fecha_inicio: "2026-11-01",
    fecha_fin: "2026-11-02",
    observacion: "x",
    sede_id: "s1",
    anulada: true,
    anulada_por: "a",
    anulada_at: "t",
    motivo_anulacion: "m",
    created_by: "c",
    created_at: "ca",
    updated_by: "u",
    updated_at: "ua",
    subtipo: "ARL",
    detalles: { motivo: "m" },
    sede_nombre: "CORPORATIVO GENERAL",
    responsable_id: "r1",
    responsable_nombre: "Ana Líder",
    adjunto_path: "2026/11/a-adjunto.pdf",
    firma_path: "2026/11/a-firma.png",
    extra: "leak",
  };
  assert.deepEqual(toNovedadDto(row), {
    id: "u1",
    cedula: "123456",
    tipo: "Permisos",
    fechaInicio: "2026-11-01",
    fechaFin: "2026-11-02",
    observacion: "x",
    subtipo: "ARL",
    detalles: { motivo: "m" },
    sedeId: "s1",
    sedeNombre: "CORPORATIVO GENERAL",
    responsableNombre: "Ana Líder",
    hasAdjunto: true,
    hasFirma: true,
    hasHistoria: false,
    hasSoporte: false,
    anulada: true,
    anuladaPor: "a",
    anuladaAt: "t",
    motivoAnulacion: "m",
    createdBy: "c",
    createdAt: "ca",
    updatedBy: "u",
    updatedAt: "ua",
  });
  const sparse = toNovedadDto({ id: "u2", cedula: "1", tipo: "Permisos académicos", fecha_inicio: "d", fecha_fin: "d" });
  assert.equal(sparse.observacion, null);
  assert.equal(sparse.sedeId, null);
  assert.equal(sparse.anulada, false);
  assert.equal(sparse.anuladaPor, null);
  assert.equal(sparse.subtipo, null);
  assert.deepEqual(sparse.detalles, {});
  assert.equal(sparse.sedeNombre, null);
  assert.equal(sparse.responsableNombre, null);
  assert.equal(sparse.hasAdjunto, false);
  assert.equal(sparse.hasFirma, false);
  assert.equal("adjuntoPath" in sparse || "firmaPath" in sparse || "responsableId" in sparse, false);
});
