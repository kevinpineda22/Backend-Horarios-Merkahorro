import test from "node:test";
import assert from "node:assert/strict";
import { ADJ, ADJ2, FIR, ID_A, createFakeRepo, createFakeStorage } from "./helpers.js";

const { createNovedadesService } = await import("../../src/modules/novedades/novedades.service.js");

const NOW = new Date("2026-11-06T15:00:00.000Z");
const admin = Object.freeze({ role: "admin", sedeIds: null });
const user = { id: "user-1", email: "lider@merka.co" };
const UUID = "3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab";
const HIS = `2026/11/${UUID}-historia.pdf`;
const HIS2 = `2026/11/aaaaaaaa-5d4a-4b6e-9a1c-0123456789ab-historia.pdf`;
const SOP = `2026/11/${UUID}-soporte.jpg`;

const base = { cedula: "1020304050", tipo: "Vacaciones", subtipo: null, fechaInicio: "2026-11-03", fechaFin: "2026-11-07", observacion: null, sedeId: "s1", sedeNombre: null, adjuntoPath: null, firmaPath: null, historiaPath: null, soportePath: null, detalles: { periodo: "2026", fechaRegreso: "2026-11-16" } };
const row = (o) => ({ id: ID_A, cedula: "1020304050", tipo: "Permisos", fecha_inicio: "2026-11-03", fecha_fin: "2026-11-07", sede_id: "s1", created_by: "x", detalles: {}, ...o });

function make({ seed, files = [ADJ, ADJ2, FIR, HIS, HIS2, SOP] } = {}) {
  const repo = createFakeRepo(seed);
  const storage = createFakeStorage(files);
  const profilesRepo = { findById: async () => ({ nombre: "Laura Líder" }) };
  return { repo, storage, svc: createNovedadesService({ repo, storage, profilesRepo, now: () => NOW }) };
}
const details = async (p) => {
  try {
    await p;
  } catch (e) {
    assert.equal(e.statusCode, 400);
    assert.equal(e.code, "VALIDATION_ERROR");
    return Object.fromEntries(e.details.map((d) => [d.path, d.message]));
  }
  assert.fail("expected rejection");
};

// ---- create ------------------------------------------------------------------------------------
test("create Permisos: detalles, soporte and historia columns are stored; the DTO exposes detalles and flags", async () => {
  const { svc, repo, storage } = make();
  const { data } = await svc.create(admin, user, { ...base, tipo: "Permisos", soportePath: SOP, detalles: { motivo: "Cita", porHoras: true, horas: [{ fecha: "2026-11-04", inicio: "08:00", fin: "10:00" }] } });
  const ins = repo.calls.insert[0];
  assert.deepEqual(ins.detalles, { motivo: "Cita", porHoras: true, horas: [{ fecha: "2026-11-04", inicio: "08:00", fin: "10:00" }] });
  assert.equal(ins.soporte_path, SOP);
  assert.equal(ins.historia_path, null);
  assert.deepEqual(storage.calls.exists, [SOP]);
  assert.deepEqual(data.detalles, ins.detalles);
  assert.equal(data.hasSoporte, true);
  assert.equal(data.hasHistoria, false);
});

test("create: the per-type rules are enforced in the service too, with body.detalles.<field> paths", async () => {
  const { svc, repo } = make();
  assert.deepEqual(await details(svc.create(admin, user, { ...base, tipo: "Permisos", detalles: {} })), {
    "body.detalles.motivo": "El motivo del permiso es obligatorio",
  });
  assert.deepEqual(await details(svc.create(admin, user, { ...base, tipo: "Licencias", subtipo: "Remunerada", detalles: { dias: 0, motivo: "m" } })), {
    "body.detalles.dias": "Los días de la licencia deben ser un número entero mayor a 0",
  });
  const eg = { ...base, tipo: "Incapacidades", subtipo: "Enfermedad general", observacion: "Reposo", adjuntoPath: ADJ };
  assert.deepEqual(Object.keys(await details(svc.create(admin, user, { ...eg, detalles: {} }))), ["body.detalles.duracion"]);
  assert.deepEqual(Object.keys(await details(svc.create(admin, user, { ...eg, observacion: null, detalles: { duracion: "Mayor a 3 días" } }))).sort(), ["body.historiaPath", "body.observacion"]);
  assert.equal(repo.calls.insert.length, 0);
});

test("create Incapacidades enfermedad general: historia is optional up to 3 days and stored when sent", async () => {
  const { svc, repo } = make();
  const eg = { ...base, tipo: "Incapacidades", subtipo: "Enfermedad general", fechaFin: "2026-11-05", observacion: "Reposo", adjuntoPath: ADJ, detalles: { duracion: "Menor o igual a 3 días" } };
  await svc.create(admin, user, eg);
  await svc.create(admin, user, { ...eg, adjuntoPath: ADJ2, historiaPath: HIS });
  assert.equal(repo.calls.insert[0].historia_path, null);
  assert.equal(repo.calls.insert[1].historia_path, HIS);
  assert.equal(repo.calls.insert[0].responsable_id, null, "only ARL has a responsable");
  assert.equal(repo.calls.insert[0].firma_path, null);
});

test("create: soporte / historia that were never uploaded are a 400 on the right field", async () => {
  const { svc, repo } = make({ files: [] });
  assert.deepEqual(await details(svc.create(admin, user, { ...base, tipo: "Permisos", soportePath: SOP, detalles: { motivo: "m" } })), {
    "body.soportePath": "El soporte del permiso no se encontró; súbelo de nuevo.",
  });
  const eg = { ...base, tipo: "Incapacidades", subtipo: "Enfermedad general", observacion: "r", adjuntoPath: ADJ, historiaPath: HIS, detalles: { duracion: "Mayor a 3 días" } };
  assert.deepEqual(Object.keys(await details(svc.create(admin, user, eg))).sort(), ["body.adjuntoPath", "body.historiaPath"]);
  assert.equal(repo.calls.insert.length, 0);
});

// ---- update: strict tier (tipo / subtipo / detalles touched) -----------------------------------
test("update detalles: replaces the whole object (normalized) and is validated against the merged tipo", async () => {
  const { svc, repo } = make({ seed: [row({ detalles: { motivo: "viejo" } })] });
  const { data } = await svc.update(admin, user, ID_A, { detalles: { motivo: "  nuevo  " } });
  assert.deepEqual(repo.calls.update[0].patch.detalles, { motivo: "nuevo" });
  assert.deepEqual(data.detalles, { motivo: "nuevo" });
  assert.deepEqual(await details(svc.update(admin, user, ID_A, { detalles: { motivo: "m", otro: 1 } })), { "body.detalles.otro": "Campo no permitido: otro" });
  assert.equal(repo.calls.update.length, 1);
});

test("update: a legacy row (detalles {}) touched on tipo, subtipo or detalles must now satisfy the per-type rules", async () => {
  const { svc } = make({ seed: [row()] });
  assert.deepEqual(await details(svc.update(admin, user, ID_A, { tipo: "Permisos" })), { "body.detalles.motivo": "El motivo del permiso es obligatorio" });
  assert.deepEqual(Object.keys(await details(svc.update(admin, user, ID_A, { detalles: {} }))), ["body.detalles.motivo"]);
  await svc.update(admin, user, ID_A, { tipo: "Permisos", detalles: { motivo: "m" } });
});

test("update tipo: details of the previous tipo are dropped (not carried over) and the new ones are required", async () => {
  const { svc, repo } = make({ seed: [row({ detalles: { motivo: "m" } })] });
  assert.deepEqual(Object.keys(await details(svc.update(admin, user, ID_A, { tipo: "Licencias", subtipo: "Remunerada" }))).sort(), ["body.detalles.dias", "body.detalles.motivo"]);
  assert.deepEqual(Object.keys(await details(svc.update(admin, user, ID_A, { tipo: "Vacaciones" }))).sort(), ["body.detalles.fechaRegreso", "body.detalles.periodo"]);
  const { data } = await svc.update(admin, user, ID_A, { tipo: "Vacaciones", detalles: { periodo: "2026", fechaRegreso: "2026-11-16" } });
  assert.deepEqual(repo.calls.update[0].patch.detalles, { periodo: "2026", fechaRegreso: "2026-11-16" }, "nothing of the previous tipo is carried over");
  assert.deepEqual(data.detalles, { periodo: "2026", fechaRegreso: "2026-11-16" });
});

test("update tipo: files that no longer belong to the new tipo are cleared automatically", async () => {
  const seed = row({ tipo: "Incapacidades", subtipo: "ARL", adjunto_path: ADJ, firma_path: FIR, historia_path: HIS, responsable_id: "r", responsable_nombre: "R", observacion: "o" });
  const { svc, repo } = make({ seed: [seed] });
  await svc.update(admin, user, ID_A, { tipo: "Vacaciones", subtipo: null, detalles: { periodo: "2026", fechaRegreso: "2026-11-16" } });
  const { patch } = repo.calls.update[0];
  for (const k of ["adjunto_path", "firma_path", "historia_path", "responsable_id", "responsable_nombre"]) assert.equal(patch[k], null, k);
  const p = make({ seed: [row({ soporte_path: SOP, detalles: { motivo: "m" } })] });
  await p.svc.update(admin, user, ID_A, { tipo: "Vacaciones", detalles: { periodo: "2026", fechaRegreso: "2026-11-16" } });
  assert.equal(p.repo.calls.update[0].patch.soporte_path, null);
});

test("update ARL -> Enfermedad general: keeps adjunto and historia, drops firma and responsable, asks for the duration", async () => {
  const seed = row({ tipo: "Incapacidades", subtipo: "ARL", adjunto_path: ADJ, firma_path: FIR, historia_path: HIS, responsable_id: "r", responsable_nombre: "R", observacion: "o" });
  const { svc, repo } = make({ seed: [seed] });
  assert.deepEqual(Object.keys(await details(svc.update(admin, user, ID_A, { subtipo: "Enfermedad general" }))), ["body.detalles.duracion"]);
  await svc.update(admin, user, ID_A, { subtipo: "Enfermedad general", detalles: { duracion: "Mayor a 3 días" } });
  const { patch } = repo.calls.update[0];
  assert.equal(patch.firma_path, null);
  assert.equal(patch.responsable_id, null);
  assert.equal("adjunto_path" in patch, false);
  assert.equal("historia_path" in patch, false);
  assert.deepEqual(patch.detalles, { duracion: "Mayor a 3 días" });
});

test("update Enfermedad general -> ARL: the duration is dropped; firma and historia are required; the caller becomes the responsable", async () => {
  const seed = row({ tipo: "Incapacidades", subtipo: "Enfermedad general", adjunto_path: ADJ, observacion: "o", detalles: { duracion: "Menor o igual a 3 días" } });
  const { svc, repo } = make({ seed: [seed] });
  assert.deepEqual(Object.keys(await details(svc.update(admin, user, ID_A, { subtipo: "ARL" }))).sort(), ["body.firmaPath", "body.historiaPath"]);
  await svc.update(admin, user, ID_A, { subtipo: "ARL", firmaPath: FIR, historiaPath: HIS });
  const { patch } = repo.calls.update[0];
  assert.deepEqual(patch.detalles, {});
  assert.equal(patch.responsable_id, "user-1");
  assert.equal(patch.responsable_nombre, "Laura Líder");
});

test("update: duration change to 'Mayor a 3 días' demands the historia", async () => {
  const seed = row({ tipo: "Incapacidades", subtipo: "Enfermedad general", adjunto_path: ADJ, observacion: "o", detalles: { duracion: "Menor o igual a 3 días" } });
  const { svc, repo } = make({ seed: [seed] });
  assert.deepEqual(Object.keys(await details(svc.update(admin, user, ID_A, { detalles: { duracion: "Mayor a 3 días" } }))), ["body.historiaPath"]);
  await svc.update(admin, user, ID_A, { detalles: { duracion: "Mayor a 3 días" }, historiaPath: HIS });
  assert.equal(repo.calls.update[0].patch.historia_path, HIS);
});

// ---- update: touched tier (legacy rows) ---------------------------------------------------------
test("update: Vacaciones legacy row ({}) stays editable on dates but resending tipo or detalles requires periodo and fechaRegreso", async () => {
  const { svc, repo } = make({ seed: [row({ tipo: "Vacaciones" })] });
  await svc.update(admin, user, ID_A, { fechaFin: "2026-11-10" });
  assert.equal(repo.calls.update.length, 1);
  assert.deepEqual(Object.keys(await details(svc.update(admin, user, ID_A, { tipo: "Vacaciones" }))).sort(), ["body.detalles.fechaRegreso", "body.detalles.periodo"]);
  assert.deepEqual(Object.keys(await details(svc.update(admin, user, ID_A, { detalles: { periodo: "2026" } }))), ["body.detalles.fechaRegreso"]);
  assert.equal(repo.calls.update.length, 1);
});

test("update: legacy rows stay editable on fields that do not touch tipo, subtipo or detalles", async () => {
  const { svc, repo } = make({ seed: [row({ tipo: "Licencias", subtipo: "Remunerada" })] });
  await svc.update(admin, user, ID_A, { observacion: "nota", fechaFin: "2026-11-20", sedeNombre: "X" });
  assert.deepEqual(Object.keys(repo.calls.update[0].patch).sort(), ["fecha_fin", "observacion", "sede_nombre", "updated_at", "updated_by"]);
});

test("update: a legacy ARL row can replace its signature without being forced to add the historia", async () => {
  const seed = row({ tipo: "Incapacidades", subtipo: "ARL", adjunto_path: ADJ, firma_path: FIR, responsable_id: "r", responsable_nombre: "R" });
  const { svc, repo } = make({ seed: [seed], files: [ADJ, FIR, "2026/11/bbbbbbbb-5d4a-4b6e-9a1c-0123456789ab-firma.png"] });
  await svc.update(admin, user, ID_A, { firmaPath: "2026/11/bbbbbbbb-5d4a-4b6e-9a1c-0123456789ab-firma.png" });
  assert.equal(repo.calls.update[0].patch.responsable_id, "user-1");
});

test("update: required files and the incapacidad observation cannot be emptied", async () => {
  const eg = row({ tipo: "Incapacidades", subtipo: "Enfermedad general", adjunto_path: ADJ, observacion: "o", detalles: { duracion: "Menor o igual a 3 días" } });
  const { svc, repo } = make({ seed: [eg] });
  assert.deepEqual(Object.keys(await details(svc.update(admin, user, ID_A, { adjuntoPath: null }))), ["body.adjuntoPath"]);
  assert.deepEqual(Object.keys(await details(svc.update(admin, user, ID_A, { observacion: null }))), ["body.observacion"]);
  assert.equal(repo.calls.update.length, 0);
  await svc.update(admin, user, ID_A, { historiaPath: HIS });
  assert.equal(repo.calls.update[0].patch.historia_path, HIS);
});

test("update: soporte can be added, replaced and removed on permisos; a missing object is a 400", async () => {
  const { svc, repo, storage } = make({ seed: [row({ detalles: { motivo: "m" } })], files: [SOP] });
  await svc.update(admin, user, ID_A, { soportePath: SOP });
  assert.equal(repo.calls.update[0].patch.soporte_path, SOP);
  await svc.update(admin, user, ID_A, { soportePath: null });
  assert.equal(repo.calls.update[1].patch.soporte_path, null);
  assert.deepEqual(storage.calls.exists, [SOP], "no lookup when clearing");
  const none = make({ seed: [row()], files: [] });
  assert.deepEqual(await details(none.svc.update(admin, user, ID_A, { soportePath: SOP })), { "body.soportePath": "El soporte del permiso no se encontró; súbelo de nuevo." });
  const vac = make({ seed: [row({ tipo: "Vacaciones" })] });
  assert.deepEqual(Object.keys(await details(vac.svc.update(admin, user, ID_A, { soportePath: SOP }))), ["body.soportePath"]);
});

// ---- update: date-dependent rules ---------------------------------------------------------------
test("update dates: modern details are re-checked against the new range; legacy rows are not", async () => {
  const horas = [{ fecha: "2026-11-06", inicio: "08:00", fin: "09:00" }];
  const modern = make({ seed: [row({ detalles: { motivo: "m", porHoras: true, horas } })] });
  assert.deepEqual(await details(modern.svc.update(admin, user, ID_A, { fechaFin: "2026-11-05" })), {
    "body.detalles.horas.0.fecha": "La fecha debe estar dentro del rango de la novedad",
  });
  await modern.svc.update(admin, user, ID_A, { fechaFin: "2026-11-08" });
  const legacy = make({ seed: [row()] });
  await legacy.svc.update(admin, user, ID_A, { fechaFin: "2026-11-05" });

  const acad = make({ seed: [row({ tipo: "Permisos académicos", detalles: { modo: "libre", dias: [{ fecha: "2026-11-03" }, { fecha: "2026-11-07" }], detalle: "d" } })] });
  assert.deepEqual(Object.keys(await details(acad.svc.update(admin, user, ID_A, { fechaInicio: "2026-11-04" }))), ["body.fechaInicio"]);

  const vac = make({ seed: [row({ tipo: "Vacaciones", detalles: { fechaRegreso: "2026-11-08" } })] });
  assert.deepEqual(Object.keys(await details(vac.svc.update(admin, user, ID_A, { fechaFin: "2026-11-20" }))), ["body.detalles.fechaRegreso"]);
});

test("get / list expose detalles as stored, defaulting to {} for rows without the column", async () => {
  const { svc } = make({ seed: [row({ detalles: { motivo: "m" } }), row({ id: "22222222-2222-4222-8222-222222222222", detalles: undefined })] });
  const list = await svc.list(admin, {});
  assert.deepEqual(list.data.map((d) => d.detalles).sort((a, b) => Object.keys(a).length - Object.keys(b).length), [{}, { motivo: "m" }]);
  assert.deepEqual((await svc.get(admin, ID_A)).data.detalles, { motivo: "m" });
});
