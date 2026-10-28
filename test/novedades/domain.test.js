import test from "node:test";
import assert from "node:assert/strict";

const { NOVEDAD_TYPES } = await import("../../src/modules/novedades/domain/novedadTypes.js");
const { rangesOverlap, toNovedadDto } = await import("../../src/modules/novedades/domain/ranges.js");
const { ABSENCE_TYPES } = await import("../../src/modules/sugerido/domain/absences.js");

test("NOVEDAD_TYPES: the 6 canonical labels (NFC), frozen", () => {
  assert.deepEqual([...NOVEDAD_TYPES], [
    "Incapacidades",
    "Licencias",
    "Vacaciones",
    "Permisos",
    "Estudio",
    "Día de la Familia",
  ]);
  assert.equal(NOVEDAD_TYPES.at(-1), NOVEDAD_TYPES.at(-1).normalize("NFC"));
  assert.ok(Object.isFrozen(NOVEDAD_TYPES));
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
    extra: "leak",
  };
  assert.deepEqual(toNovedadDto(row), {
    id: "u1",
    cedula: "123456",
    tipo: "Permisos",
    fechaInicio: "2026-11-01",
    fechaFin: "2026-11-02",
    observacion: "x",
    sedeId: "s1",
    anulada: true,
    anuladaPor: "a",
    anuladaAt: "t",
    motivoAnulacion: "m",
    createdBy: "c",
    createdAt: "ca",
    updatedBy: "u",
    updatedAt: "ua",
  });
  const sparse = toNovedadDto({ id: "u2", cedula: "1", tipo: "Estudio", fecha_inicio: "d", fecha_fin: "d" });
  assert.equal(sparse.observacion, null);
  assert.equal(sparse.sedeId, null);
  assert.equal(sparse.anulada, false);
  assert.equal(sparse.anuladaPor, null);
});
