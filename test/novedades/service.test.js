import test from "node:test";
import assert from "node:assert/strict";
import { createFakeRepo, ID_A, ID_B, ID_C } from "./helpers.js";

const { createNovedadesService } = await import("../../src/modules/novedades/novedades.service.js");

const NOW = new Date("2026-10-28T15:00:00.000Z");
const admin = Object.freeze({ role: "admin", sedeIds: null });
const planner = Object.freeze({ role: "planner", sedeIds: ["s1"] });
const plannerAll = Object.freeze({ role: "planner", sedeIds: null });
const viewer = Object.freeze({ role: "viewer", sedeIds: ["s1"] });
const user = { id: "user-1" };
const input = { cedula: "1020304050", tipo: "Vacaciones", fechaInicio: "2026-11-03", fechaFin: "2026-11-14", observacion: null, sedeId: "s1" };

const row = (o) => ({ cedula: "1020304050", tipo: "Permisos", fecha_inicio: "2026-11-10", fecha_fin: "2026-11-15", sede_id: "s1", created_by: "x", ...o });
const make = (seed) => {
  const repo = createFakeRepo(seed);
  return { repo, svc: createNovedadesService({ repo, now: () => NOW }) };
};
const rejects = (p, status, code) =>
  assert.rejects(p, (e) => e.statusCode === status && e.code === code, `expected ${status} ${code}`);

test("create: audit fields come from the authenticated user, anulada false, DTO returned", async () => {
  const { svc, repo } = make();
  const { data, warnings } = await svc.create(admin, user, { ...input, created_by: "spoof" });
  assert.equal(repo.calls.insert[0].created_by, "user-1");
  assert.equal(repo.calls.insert[0].updated_by, "user-1");
  assert.equal(repo.calls.insert[0].created_by === "spoof", false);
  assert.equal(repo.calls.insert[0].anulada, undefined);
  assert.equal(repo.calls.insert[0].fecha_inicio, "2026-11-03");
  assert.equal(data.createdBy, "user-1");
  assert.equal(data.fechaInicio, "2026-11-03");
  assert.equal(data.anulada, false);
  assert.deepEqual(warnings, []);
});

test("create scoping (R7.7/R-c): planner needs sedeId inside own sedes; null sede is admin-only", async () => {
  const { svc } = make();
  await svc.create(planner, user, input); // own sede ok
  await rejects(svc.create(planner, user, { ...input, sedeId: "s2" }), 403, "FORBIDDEN_SEDE");
  await rejects(svc.create(planner, user, { ...input, sedeId: null }), 403, "FORBIDDEN_SEDE");
  await rejects(svc.create(plannerAll, user, { ...input, sedeId: null }), 403, "FORBIDDEN_SEDE");
  await svc.create(plannerAll, user, { ...input, sedeId: "s9" }); // all-sedes planner, real sede
  await svc.create(admin, user, { ...input, sedeId: null }); // admin may create null-sede rows
});

test("create: overlap with an active row of the same cedula yields a warning, inclusive boundary", async () => {
  const { svc } = make([
    row({ id: ID_A, fecha_inicio: "2026-11-14", fecha_fin: "2026-11-20" }), // touches last day
    row({ id: ID_B, fecha_inicio: "2026-11-15", fecha_fin: "2026-11-20" }), // one day after
    row({ id: ID_C, fecha_inicio: "2026-11-05", fecha_fin: "2026-11-06", cedula: "999999" }), // other cedula
  ]);
  const { warnings } = await svc.create(admin, user, input);
  assert.deepEqual(warnings, [{ code: "OVERLAP", ids: [ID_A] }]);
});

test("create: cancelled rows never produce overlap warnings", async () => {
  const { svc } = make([row({ id: ID_A, anulada: true, anulada_at: "t" })]);
  assert.deepEqual((await svc.create(admin, user, input)).warnings, []);
});

test("update: sets updated_by/updated_at, merges dates, warns on overlap excluding itself", async () => {
  const { svc, repo } = make([
    row({ id: ID_A, fecha_inicio: "2026-11-03", fecha_fin: "2026-11-05" }),
    row({ id: ID_B, fecha_inicio: "2026-11-20", fecha_fin: "2026-11-22" }),
  ]);
  const { data, warnings } = await svc.update(planner, user, ID_A, { fechaFin: "2026-11-21" });
  assert.equal(repo.calls.update[0].patch.updated_by, "user-1");
  assert.equal(repo.calls.update[0].patch.updated_at, NOW.toISOString());
  assert.equal(repo.calls.update[0].onlyActive, true);
  assert.equal(data.fechaFin, "2026-11-21");
  assert.deepEqual(warnings, [{ code: "OVERLAP", ids: [ID_B] }]);
});

test("update: merged range is re-validated (400) and nothing is persisted", async () => {
  const { svc, repo } = make([row({ id: ID_A, fecha_inicio: "2026-11-10", fecha_fin: "2026-11-15" })]);
  await rejects(svc.update(admin, user, ID_A, { fechaFin: "2026-11-09" }), 400, "VALIDATION_ERROR");
  await rejects(svc.update(admin, user, ID_A, { fechaInicio: "2026-11-16" }), 400, "VALIDATION_ERROR");
  assert.equal(repo.calls.update.length, 0);
  await svc.update(admin, user, ID_A, { fechaFin: "2026-11-10" }); // single day is valid
});

test("update: only provided fields change; client cannot touch audit/cancel columns", async () => {
  const { svc, repo } = make([row({ id: ID_A })]);
  await svc.update(admin, user, ID_A, { observacion: "n", anulada: true, created_by: "evil" });
  const { patch } = repo.calls.update[0];
  assert.deepEqual(Object.keys(patch).sort(), ["observacion", "updated_at", "updated_by"]);
});

test("update/anular: 404 when missing, 409 NOVEDAD_CANCELLED when cancelled", async () => {
  const { svc, repo } = make([row({ id: ID_A, anulada: true, anulada_at: "t" })]);
  await rejects(svc.update(admin, user, ID_B, { tipo: "Estudio" }), 404, "NOVEDAD_NOT_FOUND");
  await rejects(svc.anular(admin, user, ID_B, { motivo: "m" }), 404, "NOVEDAD_NOT_FOUND");
  await rejects(svc.update(admin, user, ID_A, { tipo: "Estudio" }), 409, "NOVEDAD_CANCELLED");
  await rejects(svc.anular(admin, user, ID_A, { motivo: "m" }), 409, "NOVEDAD_CANCELLED");
  assert.equal(repo.calls.update.length, 0);
});

test("update: a row cancelled between read and write (repo returns null) is a 409", async () => {
  const { svc, repo } = make([row({ id: ID_A })]);
  const original = repo.findById;
  repo.findById = async (id) => {
    const r = await original(id);
    const snapshot = { ...r }; // what the service saw: still active
    repo.rows[0].anulada = true; // concurrent cancel after the read
    return snapshot;
  };
  await rejects(svc.update(admin, user, ID_A, { tipo: "Estudio" }), 409, "NOVEDAD_CANCELLED");
});

test("write scoping on existing rows: other sede and null-sede rows are forbidden for non-admins", async () => {
  const { svc } = make([row({ id: ID_A, sede_id: "s2" }), row({ id: ID_B, sede_id: null })]);
  for (const id of [ID_A, ID_B]) {
    await rejects(svc.update(planner, user, id, { observacion: "x" }), 403, "FORBIDDEN_SEDE");
    await rejects(svc.anular(planner, user, id, { motivo: "m" }), 403, "FORBIDDEN_SEDE");
    await rejects(svc.get(planner, id), 403, "FORBIDDEN_SEDE");
  }
  await rejects(svc.update(plannerAll, user, ID_B, { observacion: "x" }), 403, "FORBIDDEN_SEDE");
  await svc.update(admin, user, ID_B, { observacion: "x" });
});

test("update: moving a row to a sede the planner cannot access (or to null) is forbidden", async () => {
  const { svc } = make([row({ id: ID_A, sede_id: "s1" })]);
  await rejects(svc.update(planner, user, ID_A, { sedeId: "s2" }), 403, "FORBIDDEN_SEDE");
  await rejects(svc.update(planner, user, ID_A, { sedeId: null }), 403, "FORBIDDEN_SEDE");
});

test("anular: sets cancel columns and updated_at/updated_by from the user and motivo", async () => {
  const { svc, repo } = make([row({ id: ID_A })]);
  const { data } = await svc.anular(planner, user, ID_A, { motivo: "duplicada" });
  const { patch, onlyActive } = repo.calls.update[0];
  assert.equal(onlyActive, true);
  assert.deepEqual(patch, {
    anulada: true,
    anulada_por: "user-1",
    anulada_at: NOW.toISOString(),
    motivo_anulacion: "duplicada",
    updated_by: "user-1",
    updated_at: NOW.toISOString(),
  });
  assert.equal(data.anulada, true);
  assert.equal(data.motivoAnulacion, "duplicada");
});

test("get: returns DTO; 404 when missing", async () => {
  const { svc } = make([row({ id: ID_A })]);
  assert.equal((await svc.get(viewer, ID_A)).data.id, ID_A);
  await rejects(svc.get(viewer, ID_B), 404, "NOVEDAD_NOT_FOUND");
});

test("list scoping: admin sees null-sede rows; others never do; foreign sede filter is 403", async () => {
  const { svc, repo } = make([
    row({ id: ID_A, sede_id: "s1" }),
    row({ id: ID_B, sede_id: "s2" }),
    row({ id: ID_C, sede_id: null }),
  ]);
  const ids = async (access, q = {}) => (await svc.list(access, { incluirAnuladas: false, ...q })).data.map((d) => d.id).sort();
  assert.deepEqual(await ids(admin), [ID_A, ID_B, ID_C].sort());
  assert.deepEqual(await ids(viewer), [ID_A]);
  assert.deepEqual(await ids(planner), [ID_A]);
  assert.deepEqual(await ids(plannerAll), [ID_A, ID_B].sort()); // all sedes, still no null-sede rows
  assert.deepEqual(await ids(viewer, { sede: "s1" }), [ID_A]);
  await rejects(svc.list(viewer, { incluirAnuladas: false, sede: "s2" }), 403, "FORBIDDEN_SEDE");
  assert.deepEqual(await ids(admin, { sede: "s2" }), [ID_B]);
  assert.equal(repo.calls.list.every((f) => f.limit === 501), true);
});

test("list: filters pass through, cancelled excluded by default, 500 cap with truncated", async () => {
  const many = Array.from({ length: 501 }, (_, i) =>
    row({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, fecha_inicio: "2026-11-01", fecha_fin: "2026-11-02" }),
  );
  const { svc } = make([...many, row({ id: ID_A, cedula: "777777", anulada: true, anulada_at: "t" })]);
  const big = await svc.list(admin, { incluirAnuladas: false });
  assert.equal(big.data.length, 500);
  assert.equal(big.truncated, true);

  const small = make([row({ id: ID_A, anulada: true, anulada_at: "t" }), row({ id: ID_B })]).svc;
  const r = await small.list(admin, { incluirAnuladas: false });
  assert.equal(r.truncated, false);
  assert.deepEqual(r.data.map((d) => d.id), [ID_B]);
  assert.equal((await small.list(admin, { incluirAnuladas: true })).data.length, 2);
});
