import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NOVEDAD_TYPES } from "../../src/modules/novedades/domain/novedadTypes.js";
import { ALLOWED_MIME_TYPES, MAX_FILE_BYTES, NOVEDADES_BUCKET, isValidObjectPath } from "../../src/modules/novedades/domain/novedadFiles.js";

// Static checks only: the migration is applied manually and never run by tests.
const read = (rel) => readFileSync(new URL(`../../db/${rel}`, import.meta.url), "utf8");
const sql = read("migrations/006_novedades_arl.sql");
const down = read("migrations/rollback/006_novedades_arl.down.sql");
const verify = read("verification/006_novedades_arl_verify.sql");
const flat = (s) => s.toLowerCase().replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
const norm = flat(sql);

test("no file contains a NUL byte", () => {
  for (const s of [sql, down, verify]) assert.equal(s.includes("\u0000"), false);
});

test("tipo CHECK lists the stored labels exactly as the domain (NFC), without Estudio", () => {
  const m = /add constraint novedades_tipo_chk check \(tipo in \(([^)]*)\)\)/.exec(sql.replace(/\s+/g, " "));
  assert.ok(m, "tipo check not found");
  const listed = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  assert.deepEqual(listed, [...NOVEDAD_TYPES]);
  for (const t of listed) assert.equal(t, t.normalize("NFC"));
  assert.ok(!listed.includes("Estudio"));
});

test("old tipo constraint is dropped before the rename and the new one added after it", () => {
  const drop = norm.indexOf("drop constraint");
  const rename = norm.indexOf("set tipo = 'permisos académicos' where tipo = 'estudio'");
  const add = norm.indexOf("add constraint novedades_tipo_chk");
  assert.ok(drop >= 0 && rename > drop && add > rename, `order drop=${drop} rename=${rename} add=${add}`);
});

test("scheduler blocking types are rewritten (Estudio -> Permisos académicos) and the default updated", () => {
  assert.match(norm, /update sugerido_settings set blocking_absence_types = /);
  assert.ok(norm.includes("'estudio' then 'permisos académicos'"));
  assert.match(norm, /alter table sugerido_settings alter column blocking_absence_types set default '\{incapacidades,licencias,vacaciones,permisos,"permisos académicos","día de la familia"\}'/);
});

test("adds the new nullable columns idempotently", () => {
  for (const col of [
    "subtipo text",
    "sede_nombre text",
    "responsable_id uuid",
    "responsable_nombre text",
    "adjunto_path text",
    "firma_path text",
  ]) {
    assert.ok(norm.includes(`add column if not exists ${col}`), `missing ${col}`);
    assert.ok(!norm.includes(`${col} not null`), `${col} must be nullable`);
  }
});

test("subtipo CHECK is consistent with tipo", () => {
  assert.match(norm, /add constraint novedades_subtipo_chk check/);
  assert.ok(norm.includes("subtipo in ('arl', 'enfermedad general')") || norm.includes("subtipo in ('arl','enfermedad general')"));
  assert.ok(norm.includes("subtipo in ('remunerada', 'no remunerada')") || norm.includes("subtipo in ('remunerada','no remunerada')"));
  assert.match(norm, /tipo not in \('incapacidades', ?'licencias'\) and subtipo is null/);
});

test("ARL CHECK ties files and responsable to subtipo ARL, null-safe", () => {
  const m = /add constraint novedades_arl_chk check \((.*?)\); /.exec(norm);
  assert.ok(m, "arl check not found");
  assert.ok(m[1].includes("coalesce(subtipo, '') = 'arl'"));
  for (const col of ["adjunto_path", "firma_path", "responsable_id"]) assert.ok(m[1].includes(`${col} is not null`), col);
  assert.ok(m[1].includes("adjunto_path is null") && m[1].includes("firma_path is null"));
});

test("storage paths and sede_nombre are constrained", () => {
  assert.match(norm, /add constraint novedades_paths_chk check/);
  assert.ok(norm.includes("-adjunto\\.(pdf|png|jpg|webp)$"));
  assert.ok(norm.includes("-firma\\.png$"));
  assert.match(norm, /add constraint novedades_sede_nombre_chk check \(char_length\(sede_nombre\) between 1 and 120\)/);
});

test("the SQL path regexes accept what the domain generates and agree with its pattern", () => {
  const id = "3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab";
  assert.ok(isValidObjectPath("adjunto", `2026/11/${id}-adjunto.pdf`));
  assert.ok(isValidObjectPath("firma", `2026/11/${id}-firma.png`));
  assert.ok(sql.includes("[0-9]{4}/(0[1-9]|1[0-2])/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-adjunto"));
});

test("private bucket matches the domain constants and has no storage policies", () => {
  const flatSql = sql.replace(/\s+/g, " ").toLowerCase();
  assert.ok(flatSql.includes("insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)"));
  assert.ok(flatSql.includes(`values ('${NOVEDADES_BUCKET}', '${NOVEDADES_BUCKET}', false, ${MAX_FILE_BYTES}, array[${ALLOWED_MIME_TYPES.map((m) => `'${m}'`).join(", ")}])`));
  assert.ok(flatSql.includes("on conflict (id) do nothing"));
  assert.doesNotMatch(norm, /create policy/);
  assert.doesNotMatch(norm, /storage\.objects/);
});

test("novedades keeps RLS and revoked privileges (not relaxed by 006)", () => {
  assert.doesNotMatch(norm, /grant .* to (anon|authenticated)/);
  assert.doesNotMatch(norm, /disable row level security/);
});

test("rollback restores Estudio, the old CHECK and drops every new column", () => {
  const d = flat(down);
  assert.ok(d.includes("set tipo = 'estudio' where tipo = 'permisos académicos'"));
  assert.match(d, /add constraint novedades_tipo_check check \(tipo in \('incapacidades', 'licencias', 'vacaciones', 'permisos', 'estudio', 'día de la familia'\)\)/);
  for (const col of ["subtipo", "sede_nombre", "responsable_id", "responsable_nombre", "adjunto_path", "firma_path"]) {
    assert.ok(d.includes(`drop column if exists ${col}`), `rollback keeps ${col}`);
  }
  for (const c of ["novedades_subtipo_chk", "novedades_arl_chk", "novedades_paths_chk", "novedades_sede_nombre_chk", "novedades_tipo_chk"]) {
    assert.ok(d.includes(`drop constraint if exists ${c}`), `rollback keeps ${c}`);
  }
  assert.ok(d.includes("blocking_absence_types"));
});

test("verification script runs in one transaction that ends with ROLLBACK", () => {
  const v = flat(verify);
  assert.match(v, /^ ?begin; /);
  assert.match(v, /rollback; ?$/);
  assert.ok(!/\bcommit\b/.test(v));
  assert.ok(v.includes("all checks passed"));
  assert.ok(verify.includes("exception when"));
});
