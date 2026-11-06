import test from "node:test";
import assert from "node:assert/strict";

const { createNovedadSchema, patchNovedadSchema, anularSchema, listQuerySchema, idParamSchema, uploadSchema, fileParamsSchema } = await import(
  "../../src/modules/novedades/novedades.schemas.js"
);

const base = { cedula: "1020304050", tipo: "Vacaciones", fechaInicio: "2026-11-03", fechaFin: "2026-11-14" };
const ID = "3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab";
const ADJ = `2026/11/${ID}-adjunto.pdf`;
const HIS = `2026/11/${ID}-historia.pdf`;
const SOP = `2026/11/${ID}-soporte.png`;
// A complete, valid body for each creatable tipo.
const VALID = {
  Vacaciones: {},
  Permisos: { detalles: { motivo: "Cita médica" } },
  "Permisos académicos": { detalles: { modo: "libre", dias: [{ fecha: "2026-11-03" }, { fecha: "2026-11-14" }], detalle: "Examen final" } },
  Licencias: { subtipo: "Remunerada", detalles: { dias: 2, motivo: "Calamidad" } },
  Incapacidades: { subtipo: "Enfermedad general", observacion: "Reposo", adjuntoPath: ADJ, detalles: { duracion: "Menor o igual a 3 días" } },
};
const valid = (tipo, extra = {}) => ({ ...base, tipo, ...VALID[tipo], ...extra });
const ok = (schema, v) => {
  const r = schema.safeParse(v);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  return r.data;
};
const bad = (schema, v) => assert.equal(schema.safeParse(v).success, false, JSON.stringify(v));

test("create: valid body parses; unknown keys (created_by, anulada) are stripped", () => {
  const d = ok(createNovedadSchema, { ...base, created_by: "other", createdBy: "x", anulada: true, id: "z" });
  assert.deepEqual(d, {
    ...base,
    subtipo: null,
    observacion: null,
    sedeId: null,
    sedeNombre: null,
    adjuntoPath: null,
    firmaPath: null,
    historiaPath: null,
    soportePath: null,
    detalles: {},
  });
});

test("create: single-day range is valid, end before start is not", () => {
  ok(createNovedadSchema, { ...base, fechaInicio: "2026-11-03", fechaFin: "2026-11-03" });
  bad(createNovedadSchema, { ...base, fechaInicio: "2026-11-03", fechaFin: "2026-11-02" });
});

test("create: tipo must be one of the 5 creatable labels", () => {
  for (const tipo of ["Vacaciones", "Incapacidades", "Licencias", "Permisos", "Permisos académicos"]) {
    ok(createNovedadSchema, valid(tipo));
  }
  bad(createNovedadSchema, { ...base, tipo: "Sabático" });
  bad(createNovedadSchema, { ...base, tipo: "vacaciones" });
  bad(createNovedadSchema, { ...base, tipo: "Estudio" });
});

test("create: Día de la Familia can no longer be created, in any Unicode form", () => {
  bad(createNovedadSchema, { ...base, tipo: "Día de la Familia" });
  bad(createNovedadSchema, { ...base, tipo: "Día de la Familia".normalize("NFD") });
});

test("create: tipo in NFD form is normalized to the canonical NFC label", () => {
  const nfd = "Permisos académicos".normalize("NFD");
  assert.notEqual(nfd, "Permisos académicos");
  assert.equal(ok(createNovedadSchema, valid("Permisos académicos", { tipo: nfd })).tipo, "Permisos académicos".normalize("NFC"));
});

const ARL = {
  tipo: "Incapacidades",
  subtipo: "ARL",
  observacion: "Accidente de trabajo",
  adjuntoPath: ADJ,
  historiaPath: HIS,
  firmaPath: `2026/11/${ID}-firma.png`,
};
const msgs = (v) =>
  createNovedadSchema.safeParse({ ...base, ...v }).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`) ?? [];

test("create: Incapacidades and Licencias require a valid subtipo", () => {
  bad(createNovedadSchema, { ...base, tipo: "Incapacidades" });
  bad(createNovedadSchema, { ...base, tipo: "Incapacidades", subtipo: "Remunerada" });
  bad(createNovedadSchema, { ...base, tipo: "Licencias" });
  bad(createNovedadSchema, { ...base, tipo: "Licencias", subtipo: "ARL" });
  assert.equal(ok(createNovedadSchema, valid("Licencias", { subtipo: "No remunerada" })).subtipo, "No remunerada");
  assert.ok(msgs({ tipo: "Incapacidades" }).some((m) => m.startsWith("subtipo: ")));
});

test("create: other tipos reject any subtipo", () => {
  bad(createNovedadSchema, { ...base, subtipo: "ARL" });
  bad(createNovedadSchema, { ...base, tipo: "Permisos", subtipo: "Remunerada" });
  assert.equal(ok(createNovedadSchema, { ...base, subtipo: null }).subtipo, null);
});

test("create: ARL requires observacion, adjunto, historia and firma (Spanish messages); the happy path parses", () => {
  assert.equal(ok(createNovedadSchema, { ...base, ...ARL }).firmaPath, ARL.firmaPath);
  assert.deepEqual(msgs({ ...ARL, adjuntoPath: undefined, firmaPath: undefined, historiaPath: undefined, observacion: undefined }).sort(), [
    "adjuntoPath: Debes adjuntar el soporte de la incapacidad ARL.",
    "firmaPath: Falta la firma del líder responsable.",
    "historiaPath: Debes adjuntar la historia clínica.",
    "observacion: La observación es obligatoria para las incapacidades.",
  ]);
  bad(createNovedadSchema, { ...base, ...ARL, firmaPath: null });
});

test("create: files only where they belong", () => {
  bad(createNovedadSchema, valid("Incapacidades", { firmaPath: ARL.firmaPath })); // only ARL signs
  bad(createNovedadSchema, valid("Vacaciones", { adjuntoPath: ADJ }));
  bad(createNovedadSchema, valid("Vacaciones", { historiaPath: HIS }));
  bad(createNovedadSchema, valid("Vacaciones", { soportePath: SOP }));
  bad(createNovedadSchema, valid("Licencias", { firmaPath: ARL.firmaPath }));
  bad(createNovedadSchema, valid("Permisos", { historiaPath: HIS }));
  ok(createNovedadSchema, valid("Permisos", { soportePath: SOP }));
  ok(createNovedadSchema, valid("Permisos académicos", { soportePath: SOP }));
  ok(createNovedadSchema, valid("Incapacidades", { historiaPath: HIS }));
});

test("create: file paths must match the server-generated pattern per kind", () => {
  bad(createNovedadSchema, { ...base, ...ARL, adjuntoPath: "../../etc/passwd" });
  bad(createNovedadSchema, { ...base, ...ARL, adjuntoPath: "2026/11/not-a-uuid-adjunto.pdf" });
  bad(createNovedadSchema, { ...base, ...ARL, adjuntoPath: ARL.firmaPath }); // firma path in adjunto slot
  bad(createNovedadSchema, { ...base, ...ARL, firmaPath: ARL.adjuntoPath }); // pdf is not a valid signature
  bad(createNovedadSchema, { ...base, ...ARL, firmaPath: ARL.firmaPath.replace(".png", ".jpg") });
  bad(createNovedadSchema, { ...base, ...ARL, adjuntoPath: "https://x.co/a.pdf" });
  ok(createNovedadSchema, { ...base, ...ARL, adjuntoPath: ARL.adjuntoPath.replace(".pdf", ".webp") });
  bad(createNovedadSchema, { ...base, ...ARL, historiaPath: ADJ }); // adjunto path in historia slot
  bad(createNovedadSchema, valid("Permisos", { soportePath: HIS }));
  bad(createNovedadSchema, valid("Permisos", { soportePath: "https://x.co/s.pdf" }));
  ok(createNovedadSchema, valid("Permisos", { soportePath: SOP.replace(".png", ".webp") }));
});

test("create: sedeNombre is trimmed, whitespace-collapsed, max 120, blank -> null", () => {
  assert.equal(ok(createNovedadSchema, { ...base, sedeNombre: "  CORPORATIVO   GENERAL " }).sedeNombre, "CORPORATIVO GENERAL");
  assert.equal(ok(createNovedadSchema, { ...base, sedeNombre: "   " }).sedeNombre, null);
  assert.equal(ok(createNovedadSchema, { ...base, sedeNombre: null }).sedeNombre, null);
  ok(createNovedadSchema, { ...base, sedeNombre: "x".repeat(120) });
  bad(createNovedadSchema, { ...base, sedeNombre: "x".repeat(121) });
  bad(createNovedadSchema, { ...base, sedeNombre: 5 });
});

test("create: responsable fields from the client are stripped (they come from the session)", () => {
  const d = ok(createNovedadSchema, { ...base, responsableId: "x", responsableNombre: "y", responsable_id: "z" });
  assert.equal("responsableId" in d || "responsableNombre" in d || "responsable_id" in d, false);
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

test("patch: new fields are validated field by field; cross-field rules run in the service", () => {
  assert.deepEqual(ok(patchNovedadSchema, { subtipo: "ARL" }), { subtipo: "ARL" });
  assert.deepEqual(ok(patchNovedadSchema, { subtipo: null }), { subtipo: null });
  bad(patchNovedadSchema, { subtipo: "Otro" });
  assert.deepEqual(ok(patchNovedadSchema, { sedeNombre: " CORPORATIVO GENERAL " }), { sedeNombre: "CORPORATIVO GENERAL" });
  assert.deepEqual(ok(patchNovedadSchema, { adjuntoPath: ARL.adjuntoPath, firmaPath: null }), { adjuntoPath: ARL.adjuntoPath, firmaPath: null });
  assert.deepEqual(ok(patchNovedadSchema, { historiaPath: HIS, soportePath: null }), { historiaPath: HIS, soportePath: null });
  bad(patchNovedadSchema, { historiaPath: ADJ });
  bad(patchNovedadSchema, { soportePath: "nope.pdf" });
  bad(patchNovedadSchema, { adjuntoPath: "nope.pdf" });
  bad(patchNovedadSchema, { firmaPath: ARL.adjuntoPath });
  ok(patchNovedadSchema, { tipo: "Permisos académicos" });
  bad(patchNovedadSchema, { tipo: "Día de la Familia" });
  bad(patchNovedadSchema, { tipo: "Estudio" });
});

test("list query: tipo filter still accepts every stored tipo, including the historical one", () => {
  assert.equal(ok(listQuerySchema, { tipo: "Día de la Familia" }).tipo, "Día de la Familia");
  assert.equal(ok(listQuerySchema, { tipo: "Permisos académicos" }).tipo, "Permisos académicos");
  bad(listQuerySchema, { tipo: "Estudio" });
});

test("uploads body: kind, file name, content type and size (<= 10 MB) are validated", () => {
  const up = { kind: "adjunto", fileName: "incapacidad.pdf", contentType: "application/pdf", size: 1024, sedeId: "s1" };
  assert.deepEqual(ok(uploadSchema, up), up);
  assert.equal(ok(uploadSchema, { ...up, sedeId: undefined }).sedeId, null);
  for (const contentType of ["image/png", "image/jpeg", "image/webp"]) ok(uploadSchema, { ...up, contentType });
  bad(uploadSchema, { ...up, kind: "otro" });
  bad(uploadSchema, { ...up, contentType: "text/html" });
  bad(uploadSchema, { ...up, contentType: "application/zip" });
  bad(uploadSchema, { ...up, fileName: "" });
  bad(uploadSchema, { ...up, fileName: "x".repeat(256) });
  bad(uploadSchema, { ...up, size: 0 });
  bad(uploadSchema, { ...up, size: -1 });
  bad(uploadSchema, { ...up, size: 1.5 });
  bad(uploadSchema, { ...up, size: "100" });
  ok(uploadSchema, { ...up, size: 10 * 1024 * 1024 });
  bad(uploadSchema, { ...up, size: 10 * 1024 * 1024 + 1 });
});

test("uploads body: the signature must be a PNG", () => {
  const sig = { kind: "firma", fileName: "firma.png", contentType: "image/png", size: 500, sedeId: null };
  ok(uploadSchema, sig);
  bad(uploadSchema, { ...sig, contentType: "image/jpeg" });
  bad(uploadSchema, { ...sig, contentType: "application/pdf" });
});

test("file params: uuid id and kind adjunto|firma|historia|soporte", () => {
  const id = "3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab";
  ok(fileParamsSchema, { id, kind: "adjunto" });
  ok(fileParamsSchema, { id, kind: "firma" });
  bad(fileParamsSchema, { id, kind: "otro" });
  bad(fileParamsSchema, { id: "1", kind: "firma" });
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

test("cedula follows the company rule: leading zeros stripped, then 5..15 digits (R-b, R-h)", () => {
  assert.equal(ok(createNovedadSchema, { ...base, cedula: "0012345678" }).cedula, "12345678");
  assert.equal(ok(createNovedadSchema, { ...base, cedula: " 00.123.456 " }).cedula, "123456");
  assert.equal(ok(patchNovedadSchema, { cedula: "0012345" }).cedula, "12345");
  bad(createNovedadSchema, { ...base, cedula: "00001234" });
  bad(createNovedadSchema, { ...base, cedula: "0000" });
  bad(createNovedadSchema, { ...base, cedula: "00123x456" });
  bad(patchNovedadSchema, { cedula: "00001234" });
});

test("cedula made only of zeros is rejected even though it has 5..15 digits", () => {
  bad(createNovedadSchema, { ...base, cedula: "0000000" });
  bad(createNovedadSchema, { ...base, cedula: "000.000.000" });
  bad(patchNovedadSchema, { cedula: "00000" });
  bad(listQuerySchema, { cedula: "0000000" });
});

test("list query: ?cedula=0012345 equals 12345; letters and short normalized values are rejected", () => {
  assert.equal(ok(listQuerySchema, { cedula: "0012345" }).cedula, "12345");
  assert.equal(ok(listQuerySchema, { cedula: "12345" }).cedula, "12345");
  bad(listQuerySchema, { cedula: "00001234" });
  bad(listQuerySchema, { cedula: "12a45" });
});

// ---- detalles -----------------------------------------------------------------------------------
const issuesOf = (schema, v) => schema.safeParse(v).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`).sort() ?? [];

test("create: detalles defaults to {} and must be a plain object", () => {
  assert.deepEqual(ok(createNovedadSchema, base).detalles, {});
  for (const detalles of [null, [], "x", 5]) bad(createNovedadSchema, { ...base, detalles });
  assert.deepEqual(issuesOf(createNovedadSchema, { ...base, detalles: [] }), ["detalles: detalles debe ser un objeto"]);
});

test("create: every tipo validates its detalles with Spanish messages at body.detalles.<field>", () => {
  assert.deepEqual(issuesOf(createNovedadSchema, { ...base, tipo: "Permisos" }), ["detalles.motivo: El motivo del permiso es obligatorio"]);
  assert.deepEqual(issuesOf(createNovedadSchema, valid("Licencias", { detalles: {} })), [
    "detalles.dias: Los días de la licencia deben ser un número entero mayor a 0",
    "detalles.motivo: El motivo de la licencia es obligatorio",
  ]);
  assert.deepEqual(issuesOf(createNovedadSchema, valid("Incapacidades", { detalles: {} })), [
    "detalles.duracion: Debes indicar la duración: Mayor a 3 días o Menor o igual a 3 días.",
  ]);
  assert.deepEqual(issuesOf(createNovedadSchema, valid("Vacaciones", { detalles: { extra: 1 } })), ["detalles.extra: Campo no permitido: extra"]);
  assert.deepEqual(issuesOf(createNovedadSchema, valid("Permisos", { detalles: { motivo: "m", porHoras: true, horas: [{ fecha: "2026-11-03", inicio: "10:00", fin: "09:00" }] } })), [
    "detalles.horas.0.fin: La hora fin debe ser posterior a la hora inicio",
  ]);
});

test("create: Incapacidades observacion is mandatory; enfermedad general > 3 days also needs the historia", () => {
  assert.deepEqual(issuesOf(createNovedadSchema, valid("Incapacidades", { observacion: null })), ["observacion: La observación es obligatoria para las incapacidades."]);
  assert.deepEqual(issuesOf(createNovedadSchema, valid("Incapacidades", { adjuntoPath: null })), ["adjuntoPath: Debes adjuntar el soporte de la incapacidad."]);
  assert.deepEqual(issuesOf(createNovedadSchema, valid("Incapacidades", { detalles: { duracion: "Mayor a 3 días" } })), ["historiaPath: Debes adjuntar la historia clínica."]);
  ok(createNovedadSchema, valid("Incapacidades", { detalles: { duracion: "Mayor a 3 días" }, historiaPath: HIS }));
});

test("create: Permisos académicos days must match fechaInicio / fechaFin", () => {
  assert.deepEqual(
    issuesOf(createNovedadSchema, valid("Permisos académicos", { fechaInicio: "2026-11-02" })),
    ["fechaInicio: fechaInicio debe ser el primer día seleccionado (2026-11-03)"],
  );
});

test("create: stored detalles are the normalized ones (trimmed, optionals dropped, days sorted)", () => {
  const d = ok(createNovedadSchema, valid("Licencias", { detalles: { dias: 3, motivo: "  Duelo  ", liderAprueba: "", fechaAprobacion: null } }));
  assert.deepEqual(d.detalles, { dias: 3, motivo: "Duelo" });
  const a = ok(createNovedadSchema, valid("Permisos académicos", { detalles: { modo: "libre", dias: [{ fecha: "2026-11-14" }, { fecha: "2026-11-03" }], detalle: " x " } }));
  assert.deepEqual(a.detalles, { modo: "libre", dias: [{ fecha: "2026-11-03" }, { fecha: "2026-11-14" }], detalle: "x" });
});

test("patch: detalles must be an object; the per-type rules run in the service on the merged state", () => {
  assert.deepEqual(ok(patchNovedadSchema, { detalles: { motivo: "m" } }), { detalles: { motivo: "m" } });
  assert.deepEqual(ok(patchNovedadSchema, { detalles: {} }), { detalles: {} });
  for (const detalles of [null, [], "x"]) bad(patchNovedadSchema, { detalles });
});
