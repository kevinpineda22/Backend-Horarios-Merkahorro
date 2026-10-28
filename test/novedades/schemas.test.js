import test from "node:test";
import assert from "node:assert/strict";

const { createNovedadSchema, patchNovedadSchema, anularSchema, listQuerySchema, idParamSchema } = await import(
  "../../src/modules/novedades/novedades.schemas.js"
);

const base = { cedula: "1020304050", tipo: "Vacaciones", fechaInicio: "2026-11-03", fechaFin: "2026-11-14" };
const ok = (schema, v) => {
  const r = schema.safeParse(v);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  return r.data;
};
const bad = (schema, v) => assert.equal(schema.safeParse(v).success, false, JSON.stringify(v));

test("create: valid body parses; unknown keys (created_by, anulada) are stripped", () => {
  const d = ok(createNovedadSchema, { ...base, created_by: "other", createdBy: "x", anulada: true, id: "z" });
  assert.deepEqual(d, { ...base, observacion: null, sedeId: null });
});

test("create: single-day range is valid, end before start is not", () => {
  ok(createNovedadSchema, { ...base, fechaInicio: "2026-11-03", fechaFin: "2026-11-03" });
  bad(createNovedadSchema, { ...base, fechaInicio: "2026-11-03", fechaFin: "2026-11-02" });
});

test("create: tipo must be one of the 6 labels", () => {
  for (const tipo of ["Vacaciones", "Incapacidades", "Licencias", "Permisos", "Estudio", "Día de la Familia"]) {
    ok(createNovedadSchema, { ...base, tipo });
  }
  bad(createNovedadSchema, { ...base, tipo: "Sabático" });
  bad(createNovedadSchema, { ...base, tipo: "vacaciones" });
});

test("create: tipo in NFD form is normalized to the canonical NFC label", () => {
  const nfd = "Día de la Familia".normalize("NFD");
  assert.notEqual(nfd, "Día de la Familia");
  assert.equal(ok(createNovedadSchema, { ...base, tipo: nfd }).tipo, "Día de la Familia".normalize("NFC"));
});

test("create: cedula is trimmed and separators stripped; length 5..15 digits", () => {
  assert.equal(ok(createNovedadSchema, { ...base, cedula: " 1.020.304.050 " }).cedula, "1020304050");
  assert.equal(ok(createNovedadSchema, { ...base, cedula: "1 020 304" }).cedula, "1020304");
  assert.equal(ok(createNovedadSchema, { ...base, cedula: "1,020-304-050" }).cedula, "1020304050");
  ok(createNovedadSchema, { ...base, cedula: "12345" });
  ok(createNovedadSchema, { ...base, cedula: "123456789012345" });
  bad(createNovedadSchema, { ...base, cedula: "1234" });
  bad(createNovedadSchema, { ...base, cedula: "1234567890123456" });
  bad(createNovedadSchema, { ...base, cedula: "12345abc" });
  bad(createNovedadSchema, { ...base, cedula: "" });
  bad(createNovedadSchema, { ...base, cedula: 1020304050 });
});

test("create: required fields and date format", () => {
  for (const k of ["cedula", "tipo", "fechaInicio", "fechaFin"]) {
    const { [k]: _omit, ...rest } = base;
    bad(createNovedadSchema, rest);
  }
  bad(createNovedadSchema, { ...base, fechaInicio: "03/11/2026" });
  bad(createNovedadSchema, { ...base, fechaInicio: "2026-02-30", fechaFin: "2026-03-05" });
  bad(createNovedadSchema, { ...base, fechaInicio: "2026-11-03T00:00:00Z" });
});

test("create: observacion max 1000, sedeId optional", () => {
  ok(createNovedadSchema, { ...base, observacion: "x".repeat(1000), sedeId: "s1" });
  bad(createNovedadSchema, { ...base, observacion: "x".repeat(1001) });
  assert.equal(ok(createNovedadSchema, { ...base, observacion: "  " }).observacion, null);
  bad(createNovedadSchema, { ...base, sedeId: "" });
});

test("patch: partial bodies allowed, empty body rejected, same field validation", () => {
  assert.deepEqual(ok(patchNovedadSchema, { fechaFin: "2026-12-01" }), { fechaFin: "2026-12-01" });
  assert.deepEqual(ok(patchNovedadSchema, { cedula: "1.234.567" }), { cedula: "1234567" });
  bad(patchNovedadSchema, {});
  bad(patchNovedadSchema, { created_by: "x" }); // stripped -> empty -> rejected
  bad(patchNovedadSchema, { tipo: "Sabático" });
  bad(patchNovedadSchema, { fechaInicio: "2026-12-05", fechaFin: "2026-12-01" });
  ok(patchNovedadSchema, { fechaInicio: "2026-12-05" }); // merged range is checked by the service
  assert.deepEqual(ok(patchNovedadSchema, { observacion: null }), { observacion: null });
});

test("anular: motivo required, trimmed, 1..500", () => {
  assert.equal(ok(anularSchema, { motivo: "  error de digitacion " }).motivo, "error de digitacion");
  ok(anularSchema, { motivo: "x".repeat(500) });
  bad(anularSchema, { motivo: "x".repeat(501) });
  bad(anularSchema, { motivo: "   " });
  bad(anularSchema, { motivo: "" });
  bad(anularSchema, {});
});

test("list query: all optional, dates validated, incluirAnuladas parsed from strings", () => {
  assert.deepEqual(ok(listQuerySchema, {}), { incluirAnuladas: false });
  const d = ok(listQuerySchema, {
    sede: "s1", cedula: "1.234.567", desde: "2026-11-18", hasta: "2026-11-25", tipo: "Permisos", incluirAnuladas: "true",
  });
  assert.deepEqual(d, {
    sede: "s1", cedula: "1234567", desde: "2026-11-18", hasta: "2026-11-25", tipo: "Permisos", incluirAnuladas: true,
  });
  assert.equal(ok(listQuerySchema, { incluirAnuladas: "false" }).incluirAnuladas, false);
  bad(listQuerySchema, { incluirAnuladas: "yes" });
  bad(listQuerySchema, { desde: "nope" });
  bad(listQuerySchema, { desde: "2026-11-25", hasta: "2026-11-18" });
  bad(listQuerySchema, { tipo: "Sabático" });
});

test("id param must be a uuid", () => {
  ok(idParamSchema, { id: "3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab" });
  bad(idParamSchema, { id: "123" });
});
