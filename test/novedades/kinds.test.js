import test from "node:test";
import assert from "node:assert/strict";
import { createFakeRepo, createFakeStorage, ID_A } from "./helpers.js";

const files = await import("../../src/modules/novedades/domain/novedadFiles.js");
const { uploadSchema, fileParamsSchema } = await import("../../src/modules/novedades/novedades.schemas.js");
const { toNovedadDto } = await import("../../src/modules/novedades/domain/ranges.js");
const { createNovedadesService } = await import("../../src/modules/novedades/novedades.service.js");
const { createNovedadesRepo } = await import("../../src/modules/novedades/novedades.supabase.js");

const UUID = "3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab";
const admin = Object.freeze({ role: "admin", sedeIds: null });
const HIS = `2026/11/${UUID}-historia.pdf`;
const SOP = `2026/11/${UUID}-soporte.jpg`;

test("FILE_KINDS: adjunto, firma, historia, soporte", () => {
  assert.deepEqual([...files.FILE_KINDS], ["adjunto", "firma", "historia", "soporte"]);
  assert.ok(Object.isFrozen(files.FILE_KINDS));
});

test("object paths: historia and soporte accept pdf/png/jpg/webp, with literal dots and strict kind suffix", () => {
  for (const kind of ["historia", "soporte"]) {
    for (const ext of ["pdf", "png", "jpg", "webp"]) {
      assert.ok(files.isValidObjectPath(kind, `2026/11/${UUID}-${kind}.${ext}`), `${kind}.${ext}`);
    }
    assert.equal(files.isValidObjectPath(kind, `2026/11/${UUID}-${kind}Xpdf`), false, "dot is literal");
    assert.equal(files.isValidObjectPath(kind, `2026/11/${UUID}-${kind}.gif`), false);
    assert.equal(files.isValidObjectPath(kind, `2026/13/${UUID}-${kind}.pdf`), false);
    assert.equal(files.isValidObjectPath(kind, `2026/11/${UUID}-adjunto.pdf`), false, "other kind's path");
  }
  assert.equal(files.isValidObjectPath("historia", SOP), false);
  assert.equal(files.isValidObjectPath("soporte", HIS), false);
  assert.equal(files.isValidObjectPath("adjunto", HIS), false);
});

test("buildObjectPath: yyyy/mm/<uuid>-<kind>.<ext> for the new kinds", () => {
  const now = new Date("2026-11-06T15:00:00.000Z");
  assert.equal(files.buildObjectPath({ kind: "historia", contentType: "application/pdf", now, id: UUID }), HIS);
  assert.equal(files.buildObjectPath({ kind: "soporte", contentType: "image/jpeg", now, id: UUID }), SOP);
});

test("content types: historia and soporte accept pdf and images (only firma is png-only)", () => {
  for (const kind of ["historia", "soporte"]) {
    for (const ct of ["application/pdf", "image/png", "image/jpeg", "image/webp"]) assert.ok(files.isAllowedContentType(kind, ct), `${kind} ${ct}`);
    assert.equal(files.isAllowedContentType(kind, "image/gif"), false);
  }
});

test("POST /uploads body and files params accept the new kinds", () => {
  for (const kind of ["historia", "soporte"]) {
    const up = { kind, fileName: "x.pdf", contentType: "application/pdf", size: 10, sedeId: null };
    assert.equal(uploadSchema.safeParse(up).success, true, kind);
    assert.equal(uploadSchema.safeParse({ ...up, size: 10 * 1024 * 1024 + 1 }).success, false);
    assert.equal(uploadSchema.safeParse({ ...up, contentType: "image/gif" }).success, false);
    assert.equal(fileParamsSchema.safeParse({ id: ID_A, kind }).success, true, kind);
  }
});

test("DTO: hasHistoria / hasSoporte flags never leak the paths", () => {
  const base = { id: ID_A, cedula: "1", tipo: "Permisos", fecha_inicio: "2026-11-01", fecha_fin: "2026-11-02" };
  const none = toNovedadDto(base);
  assert.equal(none.hasHistoria, false);
  assert.equal(none.hasSoporte, false);
  const full = toNovedadDto({ ...base, historia_path: HIS, soporte_path: SOP });
  assert.equal(full.hasHistoria, true);
  assert.equal(full.hasSoporte, true);
  assert.equal(JSON.stringify(full).includes(HIS) || JSON.stringify(full).includes(SOP), false);
});

test("getFileUrl: signed URLs for historia and soporte; 404 when the novedad lacks that file", async () => {
  const repo = createFakeRepo([
    { id: ID_A, cedula: "1", tipo: "Incapacidades", fecha_inicio: "2026-11-01", fecha_fin: "2026-11-02", sede_id: "s1", historia_path: HIS, soporte_path: SOP },
  ]);
  const svc = createNovedadesService({ repo, storage: createFakeStorage() });
  assert.equal((await svc.getFileUrl(admin, ID_A, "historia")).url, `https://storage.test/download/${HIS}?exp=300`);
  assert.equal((await svc.getFileUrl(admin, ID_A, "soporte")).url, `https://storage.test/download/${SOP}?exp=300`);
  const bare = createNovedadesService({
    repo: createFakeRepo([{ id: ID_A, cedula: "1", tipo: "Permisos", fecha_inicio: "2026-11-01", fecha_fin: "2026-11-02", sede_id: "s1" }]),
    storage: createFakeStorage(),
  });
  for (const kind of ["historia", "soporte", "adjunto", "firma"]) {
    await assert.rejects(bare.getFileUrl(admin, ID_A, kind), (e) => e.statusCode === 404 && e.code === "NOVEDAD_FILE_NOT_FOUND", kind);
  }
});

test("repo: unique violation on the historia / soporte indexes maps to 409 NOVEDAD_FILE_IN_USE", async () => {
  for (const idx of ["novedades_historia_path_key", "novedades_soporte_path_key"]) {
    const error = { code: "23505", message: `duplicate key value violates unique constraint "${idx}"` };
    const q = { insert: () => q, update: () => q, eq: () => q, select: () => q, single: async () => ({ data: null, error }) };
    const repo = createNovedadesRepo({ from: () => q });
    await assert.rejects(repo.insert({}), (e) => e.statusCode === 409 && e.code === "NOVEDAD_FILE_IN_USE", idx);
  }
});
