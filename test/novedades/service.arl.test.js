import test from "node:test";
import assert from "node:assert/strict";
import { ADJ, ADJ2, FIR, FIR2, ID_A, ID_B, createFakeRepo, createFakeStorage } from "./helpers.js";

const { createNovedadesService } = await import("../../src/modules/novedades/novedades.service.js");

const NOW = new Date("2026-11-06T15:00:00.000Z");
const UPLOAD_ID = "9d5c1f0e-1111-4222-8333-444455556666";
const admin = Object.freeze({ role: "admin", sedeIds: null });
const planner = Object.freeze({ role: "planner", sedeIds: ["s1"] });
const viewer = Object.freeze({ role: "viewer", sedeIds: ["s1"] });
const user = { id: "user-1", email: "lider@merka.co" };

const base = { cedula: "1020304050", tipo: "Vacaciones", subtipo: null, fechaInicio: "2026-11-03", fechaFin: "2026-11-14", observacion: null, sedeId: "s1", sedeNombre: null, adjuntoPath: null, firmaPath: null };
const arl = { ...base, tipo: "Incapacidades", subtipo: "ARL", adjuntoPath: ADJ, firmaPath: FIR };
const row = (o) => ({ cedula: "1020304050", tipo: "Permisos", fecha_inicio: "2026-11-10", fecha_fin: "2026-11-15", sede_id: "s1", created_by: "x", ...o });
const arlRow = (o) => row({ id: ID_A, tipo: "Incapacidades", subtipo: "ARL", adjunto_path: ADJ, firma_path: FIR, responsable_id: "someone", responsable_nombre: "Otra Persona", ...o });

function make({ seed, files = [ADJ, FIR, ADJ2, FIR2], profiles } = {}) {
  const repo = createFakeRepo(seed);
  const storage = createFakeStorage(files);
  const profilesRepo = { findById: async (id) => (profiles ?? { "user-1": { nombre: "Laura Líder" } })[id] ?? null };
  return { repo, storage, svc: createNovedadesService({ repo, storage, profilesRepo, now: () => NOW, newId: () => UPLOAD_ID }) };
}
const rejects = (p, status, code) => assert.rejects(p, (e) => e.statusCode === status && e.code === code, `expected ${status} ${code}`);
const details = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.details;
  }
  assert.fail("expected rejection");
};

// ---- uploads ----------------------------------------------------------------------------------
test("createUpload: server-generated path, signed URL and token; client name never in the path", async () => {
  const { svc, storage } = make();
  const out = await svc.createUpload(planner, { kind: "adjunto", fileName: "../../evil name.exe", contentType: "application/pdf", size: 10, sedeId: "s1" });
  assert.deepEqual(out, { path: `2026/11/${UPLOAD_ID}-adjunto.pdf`, signedUploadUrl: `https://storage.test/upload/2026/11/${UPLOAD_ID}-adjunto.pdf?token=T`, token: "T" });
  assert.deepEqual(storage.calls.upload, [`2026/11/${UPLOAD_ID}-adjunto.pdf`]);
  assert.ok(!out.path.includes("evil"));
});

test("createUpload: extension follows the content type; firma is always png", async () => {
  const { svc } = make();
  const ext = async (kind, contentType) => (await svc.createUpload(admin, { kind, fileName: "f", contentType, size: 1, sedeId: null })).path.split(".").pop();
  assert.equal(await ext("adjunto", "image/jpeg"), "jpg");
  assert.equal(await ext("adjunto", "image/webp"), "webp");
  assert.equal(await ext("adjunto", "image/png"), "png");
  assert.equal(await ext("firma", "image/png"), "png");
});

test("createUpload: same sede rules as create (null sede is admin-only)", async () => {
  const { svc } = make();
  const up = { kind: "adjunto", fileName: "f", contentType: "application/pdf", size: 1 };
  await rejects(svc.createUpload(planner, { ...up, sedeId: "s2" }), 403, "FORBIDDEN_SEDE");
  await rejects(svc.createUpload(planner, { ...up, sedeId: null }), 403, "FORBIDDEN_SEDE");
  await svc.createUpload(admin, { ...up, sedeId: null });
});

// ---- create -----------------------------------------------------------------------------------
test("create ARL: responsable comes from the session user (name from profiles), files are stored as paths", async () => {
  const { svc, repo, storage } = make();
  const { data } = await svc.create(planner, user, { ...arl, responsable_id: "spoof", responsableId: "spoof", responsableNombre: "Spoof" });
  const ins = repo.calls.insert[0];
  assert.equal(ins.subtipo, "ARL");
  assert.equal(ins.adjunto_path, ADJ);
  assert.equal(ins.firma_path, FIR);
  assert.equal(ins.responsable_id, "user-1");
  assert.equal(ins.responsable_nombre, "Laura Líder");
  assert.deepEqual(storage.calls.exists.sort(), [ADJ, FIR].sort());
  assert.equal(data.responsableNombre, "Laura Líder");
  assert.equal(data.hasAdjunto, true);
  assert.equal(data.hasFirma, true);
  assert.equal(JSON.stringify(data).includes(ADJ), false, "paths are not exposed");
});

test("create ARL: without profile the responsable name falls back to the session email, then null", async () => {
  const a = make({ profiles: {} });
  await a.svc.create(admin, user, arl);
  assert.equal(a.repo.calls.insert[0].responsable_nombre, "lider@merka.co");
  const b = make({ profiles: {} });
  await b.svc.create(admin, { id: "user-1" }, arl);
  assert.equal(b.repo.calls.insert[0].responsable_nombre, null);
  assert.equal(b.repo.calls.insert[0].responsable_id, "user-1");
});

test("create ARL: files that were never uploaded are a 400 on the right field and nothing is inserted", async () => {
  const { svc, repo } = make({ files: [FIR] });
  const d = await details(svc.create(admin, user, arl));
  assert.deepEqual(d.map((x) => x.path), ["body.adjuntoPath"]);
  assert.match(d[0].message, /adjunto/i);
  await rejects(svc.create(admin, user, arl), 400, "VALIDATION_ERROR");
  const none = make({ files: [] });
  assert.deepEqual((await details(none.svc.create(admin, user, arl))).map((x) => x.path).sort(), ["body.adjuntoPath", "body.firmaPath"]);
  assert.equal(repo.calls.insert.length + none.repo.calls.insert.length, 0);
});

test("create ARL: a realistic storage-js 404 for a missing object yields the 400 message, not a 500", async () => {
  const { createNovedadesStorage } = await import("../../src/modules/novedades/novedades.storage.js");
  const missing = { data: false, error: { message: "Object not found", status: 404, statusCode: "404" } };
  const client = { storage: { from: () => ({ exists: async () => missing }) } };
  const repo = createFakeRepo();
  const svc = createNovedadesService({ repo, storage: createNovedadesStorage(client), profilesRepo: { findById: async () => null }, now: () => NOW, newId: () => UPLOAD_ID });
  const d = await details(svc.create(admin, user, arl));
  assert.deepEqual(d.map((x) => x.path).sort(), ["body.adjuntoPath", "body.firmaPath"]);
  assert.match(d[0].message, /no se encontró; súbelo de nuevo\./);
  await rejects(svc.create(admin, user, arl), 400, "VALIDATION_ERROR");
  assert.equal(repo.calls.insert.length, 0);
});

test("create: ARL rules are enforced in the service too (defense in depth)", async () => {
  const { svc, repo } = make();
  const d = await details(svc.create(admin, user, { ...arl, adjuntoPath: null, firmaPath: null }));
  assert.deepEqual(d.map((x) => x.path).sort(), ["body.adjuntoPath", "body.firmaPath"]);
  await rejects(svc.create(admin, user, { ...base, tipo: "Incapacidades" }), 400, "VALIDATION_ERROR");
  assert.equal(repo.calls.insert.length, 0);
});

test("create non-ARL: subtipo and sede_nombre stored; no responsable, no files, no storage lookups", async () => {
  const { svc, repo, storage } = make();
  const { data } = await svc.create(admin, user, { ...base, tipo: "Licencias", subtipo: "No remunerada", sedeId: null, sedeNombre: "CORPORATIVO GENERAL" });
  const ins = repo.calls.insert[0];
  assert.equal(ins.subtipo, "No remunerada");
  assert.equal(ins.sede_nombre, "CORPORATIVO GENERAL");
  assert.equal(ins.sede_id, null);
  assert.equal(ins.responsable_id, null);
  assert.equal(ins.responsable_nombre, null);
  assert.equal(ins.adjunto_path, null);
  assert.equal(ins.firma_path, null);
  assert.deepEqual(storage.calls.exists, []);
  assert.equal(data.subtipo, "No remunerada");
  assert.equal(data.sedeNombre, "CORPORATIVO GENERAL");
  assert.equal(data.hasAdjunto, false);
});

test("create: existing behaviour intact — Vacaciones without extras stores nulls", async () => {
  const { svc, repo } = make();
  await svc.create(planner, user, base);
  const ins = repo.calls.insert[0];
  for (const k of ["subtipo", "sede_nombre", "responsable_id", "responsable_nombre", "adjunto_path", "firma_path"]) assert.equal(ins[k], null, k);
});

// ---- update -----------------------------------------------------------------------------------
test("update: changing subtipo to ARL needs both files (400) and sets the responsable to the current user", async () => {
  const { svc, repo } = make({ seed: [row({ id: ID_A, tipo: "Incapacidades", subtipo: "Enfermedad general" })] });
  const d = await details(svc.update(admin, user, ID_A, { subtipo: "ARL" }));
  assert.deepEqual(d.map((x) => x.path).sort(), ["body.adjuntoPath", "body.firmaPath"]);
  assert.equal(repo.calls.update.length, 0);

  const { data } = await svc.update(admin, user, ID_A, { subtipo: "ARL", adjuntoPath: ADJ, firmaPath: FIR });
  const { patch } = repo.calls.update[0];
  assert.equal(patch.subtipo, "ARL");
  assert.equal(patch.adjunto_path, ADJ);
  assert.equal(patch.firma_path, FIR);
  assert.equal(patch.responsable_id, "user-1");
  assert.equal(patch.responsable_nombre, "Laura Líder");
  assert.equal(data.hasFirma, true);
});

test("update: leaving ARL clears files and responsable automatically", async () => {
  const { svc, repo } = make({ seed: [arlRow()] });
  await svc.update(admin, user, ID_A, { subtipo: "Enfermedad general" });
  const { patch } = repo.calls.update[0];
  assert.equal(patch.subtipo, "Enfermedad general");
  assert.equal(patch.adjunto_path, null);
  assert.equal(patch.firma_path, null);
  assert.equal(patch.responsable_id, null);
  assert.equal(patch.responsable_nombre, null);
});

test("update: leaving ARL for another tipo needs an explicit subtipo null", async () => {
  const { svc, repo } = make({ seed: [arlRow()] });
  await rejects(svc.update(admin, user, ID_A, { tipo: "Vacaciones" }), 400, "VALIDATION_ERROR");
  await svc.update(admin, user, ID_A, { tipo: "Vacaciones", subtipo: null });
  const { patch } = repo.calls.update[0];
  assert.equal(patch.tipo, "Vacaciones");
  assert.equal(patch.subtipo, null);
  assert.equal(patch.adjunto_path, null);
  assert.equal(patch.responsable_id, null);
});

test("update ARL: unrelated edits keep files and responsable untouched", async () => {
  const { svc, repo, storage } = make({ seed: [arlRow()] });
  await svc.update(admin, user, ID_A, { observacion: "nota", fechaFin: "2026-11-20" });
  assert.deepEqual(Object.keys(repo.calls.update[0].patch).sort(), ["fecha_fin", "observacion", "updated_at", "updated_by"]);
  assert.deepEqual(storage.calls.exists, []);
});

test("update ARL: replacing the signature validates it and re-assigns the responsable", async () => {
  const { svc, repo, storage } = make({ seed: [arlRow()] });
  await svc.update(admin, user, ID_A, { firmaPath: FIR2 });
  const { patch } = repo.calls.update[0];
  assert.equal(patch.firma_path, FIR2);
  assert.equal(patch.responsable_id, "user-1");
  assert.equal(patch.responsable_nombre, "Laura Líder");
  assert.equal("adjunto_path" in patch, false);
  assert.deepEqual(storage.calls.exists, [FIR2]);
});

test("update ARL: replacing only the document keeps the original responsable", async () => {
  const { svc, repo } = make({ seed: [arlRow()] });
  await svc.update(admin, user, ID_A, { adjuntoPath: ADJ2 });
  const { patch } = repo.calls.update[0];
  assert.equal(patch.adjunto_path, ADJ2);
  assert.equal("responsable_id" in patch, false);
});

test("update ARL: removing a required file is rejected; a missing replacement file is a 400", async () => {
  const { svc, repo } = make({ seed: [arlRow()], files: [ADJ, FIR] });
  await rejects(svc.update(admin, user, ID_A, { adjuntoPath: null }), 400, "VALIDATION_ERROR");
  const d = await details(svc.update(admin, user, ID_A, { firmaPath: FIR2 }));
  assert.deepEqual(d.map((x) => x.path), ["body.firmaPath"]);
  assert.equal(repo.calls.update.length, 0);
});

test("update: non-ARL rows cannot receive files", async () => {
  const { svc } = make({ seed: [row({ id: ID_A })] });
  await rejects(svc.update(admin, user, ID_A, { adjuntoPath: ADJ }), 400, "VALIDATION_ERROR");
});

test("update: switching tipo to Incapacidades/Licencias requires a subtipo", async () => {
  const { svc, repo } = make({ seed: [row({ id: ID_A })] });
  await rejects(svc.update(admin, user, ID_A, { tipo: "Incapacidades" }), 400, "VALIDATION_ERROR");
  await rejects(svc.update(admin, user, ID_A, { tipo: "Licencias", subtipo: "ARL" }), 400, "VALIDATION_ERROR");
  await svc.update(admin, user, ID_A, { tipo: "Licencias", subtipo: "Remunerada" });
  assert.equal(repo.calls.update[0].patch.subtipo, "Remunerada");
});

test("update: a legacy Incapacidades row without subtipo can still be edited on other fields", async () => {
  const { svc, repo } = make({ seed: [row({ id: ID_A, tipo: "Incapacidades" })] });
  await svc.update(admin, user, ID_A, { observacion: "nota" });
  assert.deepEqual(Object.keys(repo.calls.update[0].patch).sort(), ["observacion", "updated_at", "updated_by"]);
});

test("update: sedeNombre can be set and cleared", async () => {
  const { svc, repo } = make({ seed: [row({ id: ID_A, sede_id: null })] });
  await svc.update(admin, user, ID_A, { sedeNombre: "CORPORATIVO GENERAL" });
  assert.equal(repo.calls.update[0].patch.sede_nombre, "CORPORATIVO GENERAL");
  await svc.update(admin, user, ID_A, { sedeNombre: null });
  assert.equal(repo.calls.update[1].patch.sede_nombre, null);
});

test("anular keeps working on a legacy row and never touches the files", async () => {
  const { svc, repo } = make({ seed: [arlRow()] });
  await svc.anular(admin, user, ID_A, { motivo: "m" });
  const { patch } = repo.calls.update[0];
  assert.equal("adjunto_path" in patch || "firma_path" in patch, false);
});

// ---- download URLs ----------------------------------------------------------------------------
test("getFileUrl: short-lived signed URL for the requested kind", async () => {
  const { svc, storage } = make({ seed: [arlRow()] });
  assert.deepEqual(await svc.getFileUrl(viewer, ID_A, "adjunto"), { url: `https://storage.test/download/${ADJ}?exp=300` });
  assert.deepEqual(await svc.getFileUrl(viewer, ID_A, "firma"), { url: `https://storage.test/download/${FIR}?exp=300` });
  assert.deepEqual(storage.calls.download.map((c) => c.expiresIn), [300, 300]);
});

test("getFileUrl: cancelled novedades keep their evidence readable", async () => {
  const { svc } = make({ seed: [arlRow({ anulada: true, anulada_at: "t" })] });
  assert.match((await svc.getFileUrl(admin, ID_A, "adjunto")).url, /download/);
});

test("getFileUrl: 404 when the novedad or the file does not exist; 403 outside the caller's sedes", async () => {
  const { svc } = make({ seed: [arlRow({ id: ID_A, sede_id: "s2" }), row({ id: ID_B })] });
  await rejects(svc.getFileUrl(admin, "33333333-3333-4333-8333-333333333333", "adjunto"), 404, "NOVEDAD_NOT_FOUND");
  await rejects(svc.getFileUrl(admin, ID_B, "adjunto"), 404, "NOVEDAD_FILE_NOT_FOUND");
  await rejects(svc.getFileUrl(viewer, ID_A, "adjunto"), 403, "FORBIDDEN_SEDE");
  await rejects(svc.getFileUrl(viewer, ID_B, "firma"), 404, "NOVEDAD_FILE_NOT_FOUND");
});

test("getFileUrl: null-sede novedades are admin-only", async () => {
  const { svc } = make({ seed: [arlRow({ sede_id: null })] });
  await rejects(svc.getFileUrl(viewer, ID_A, "adjunto"), 403, "FORBIDDEN_SEDE");
  await svc.getFileUrl(admin, ID_A, "adjunto");
});

test("without a storage port, ARL writes and file endpoints fail loudly with 503", async () => {
  const repo = createFakeRepo([arlRow()]);
  const svc = createNovedadesService({ repo, now: () => NOW });
  await rejects(svc.create(admin, user, arl), 503, "STORAGE_UNAVAILABLE");
  await rejects(svc.getFileUrl(admin, ID_A, "adjunto"), 503, "STORAGE_UNAVAILABLE");
  await rejects(svc.createUpload(admin, { kind: "adjunto", fileName: "f", contentType: "application/pdf", size: 1, sedeId: null }), 503, "STORAGE_UNAVAILABLE");
  void ID_B;
});
