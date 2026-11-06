import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isValidObjectPath } from "../../src/modules/novedades/domain/novedadFiles.js";

// Static checks only: the migration is applied manually and never run by tests.
const read = (rel) => readFileSync(new URL(`../../db/${rel}`, import.meta.url), "utf8");
const sql = read("migrations/007_novedades_detalles.sql");
const down = read("migrations/rollback/007_novedades_detalles.down.sql");
const verify = read("verification/007_novedades_detalles_verify.sql");
const flat = (s) => s.toLowerCase().replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
const norm = flat(sql);
const UUID = "3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab";

test("no file contains a NUL byte", () => {
  for (const s of [sql, down, verify]) assert.equal(s.includes("\u0000"), false);
});

test("detalles is a jsonb object, not null, defaulting to {} so legacy rows get {}", () => {
  assert.ok(norm.includes("add column if not exists detalles jsonb not null default '{}'"));
  assert.match(norm, /add constraint novedades_detalles_chk check \(jsonb_typeof\(detalles\) = 'object'\)/);
  assert.ok(norm.includes("drop constraint if exists novedades_detalles_chk"), "idempotent");
});

test("historia_path and soporte_path are nullable text columns added idempotently", () => {
  for (const col of ["historia_path text", "soporte_path text"]) {
    assert.ok(norm.includes(`add column if not exists ${col}`), col);
    assert.ok(!norm.includes(`${col} not null`), `${col} must be nullable`);
  }
});

test("ARL check is relaxed: any incapacidad may carry an adjunto, only ARL carries firma and responsable", () => {
  const m = /add constraint novedades_arl_chk check \((.*?)\); /.exec(norm);
  assert.ok(m, "arl check not found");
  assert.ok(m[1].includes("coalesce(subtipo, '') = 'arl' and adjunto_path is not null and firma_path is not null and responsable_id is not null"));
  assert.ok(m[1].includes("coalesce(subtipo, '') <> 'arl' and firma_path is null"));
  assert.ok(m[1].includes("adjunto_path is null or tipo = 'incapacidades'"), "adjunto only on Incapacidades");
  assert.ok(norm.indexOf("drop constraint if exists novedades_arl_chk") < norm.indexOf("add constraint novedades_arl_chk"));
});

test("historia / soporte are tied to their tipos; nothing here can reject a legacy row", () => {
  const m = /add constraint novedades_files_chk check \((.*?)\); /.exec(norm);
  assert.ok(m, "files check not found");
  assert.ok(m[1].includes("historia_path is null or tipo = 'incapacidades'"));
  assert.ok(m[1].includes("soporte_path is null or tipo in ('permisos', 'permisos académicos')"));
  // Legacy rows have no value in the new columns, and the detalles default is {}: no new CHECK may require content.
  assert.doesNotMatch(norm, /detalles \?|detalles ->>|detalles ->/);
  assert.doesNotMatch(norm, /observacion is not null/);
  assert.doesNotMatch(norm, /update novedades/);
});

test("new storage paths are constrained by the same strict regexes as the domain", () => {
  assert.match(norm, /add constraint novedades_extra_paths_chk check/);
  const re = (col) => new RegExp(new RegExp(`${col} ~ '([^']+)'`).exec(sql)[1]);
  for (const kind of ["historia", "soporte"]) {
    const dbRe = re(`${kind}_path`);
    for (const s of [
      `2026/11/${UUID}-${kind}.pdf`, `2026/11/${UUID}-${kind}.png`, `2026/11/${UUID}-${kind}.jpg`, `2026/11/${UUID}-${kind}.webp`,
      `2026/11/${UUID}-${kind}Xpdf`, `2026/11/${UUID}-${kind}.gif`, `2026/13/${UUID}-${kind}.pdf`, `2026/11/${UUID}-adjunto.pdf`, "../etc/passwd",
    ]) {
      assert.equal(isValidObjectPath(kind, s), dbRe.test(s), `${kind} ${s}`);
    }
  }
});

test("a file belongs to at most one novedad: partial unique indexes, dropped by the rollback", () => {
  for (const col of ["historia", "soporte"]) {
    assert.ok(norm.includes(`create unique index if not exists novedades_${col}_path_key on novedades (${col}_path) where ${col}_path is not null;`), col);
    assert.ok(flat(down).includes(`drop index if exists novedades_${col}_path_key;`), `rollback ${col}`);
  }
});

test("007 does not touch the bucket, RLS or privileges", () => {
  assert.doesNotMatch(norm, /storage\.|create policy|grant |disable row level security/);
});

test("rollback backs up first (with RLS), is idempotent and restores the 006 ARL check", () => {
  const d = flat(down);
  const backup = d.indexOf("create table if not exists novedades_backup_007 as select * from novedades;");
  assert.ok(backup >= 0, "backup statement missing");
  const rls = d.indexOf("alter table novedades_backup_007 enable row level security;");
  assert.ok(rls > backup, "RLS enabled on the backup");
  for (const destructive of ["drop index", "drop constraint", "drop column", "update novedades"]) {
    assert.ok(backup < d.indexOf(destructive), `backup before ${destructive}`);
  }
  assert.match(down.split("\n").slice(0, 12).join("\n"), /backup/i, "documented in the header");
  for (const c of ["novedades_detalles_chk", "novedades_files_chk", "novedades_extra_paths_chk", "novedades_arl_chk"]) {
    assert.ok(d.includes(`drop constraint if exists ${c}`), c);
  }
  for (const col of ["detalles", "historia_path", "soporte_path"]) assert.ok(d.includes(`drop column if exists ${col}`), col);
  // Rows that now carry an adjunto without being ARL would violate the 006 check: clear them before re-adding it.
  const clear = d.indexOf("set adjunto_path = null where coalesce(subtipo, '') <> 'arl'");
  const readd = d.indexOf("add constraint novedades_arl_chk");
  assert.ok(clear > 0 && readd > clear, "non-ARL adjuntos cleared before the 006 check returns");
  assert.ok(d.includes("coalesce(subtipo, '') <> 'arl' and adjunto_path is null and firma_path is null"), "exact 006 check restored");
});

test("verification runs in one transaction that ends with ROLLBACK and uses nested exception blocks", () => {
  const v = flat(verify);
  assert.match(v, /^ ?begin; /);
  assert.match(v, /rollback; ?$/);
  assert.ok(!/\bcommit\b/.test(v));
  assert.ok(v.includes("all checks passed"));
  assert.ok(verify.includes("exception when"));
});

test("verification covers the new columns, the default, the relaxed ARL rule, tipo ties, paths and unique indexes", () => {
  const v = flat(verify);
  for (const needle of [
    "'detalles'", "'historia_path'", "'soporte_path'",
    "jsonb_typeof", "novedades_historia_path_key", "novedades_soporte_path_key",
    "relrowsecurity", "legacy",
  ]) assert.ok(v.includes(needle), needle);
  assert.equal(v.split("exception when unique_violation").length - 1, 2, "both reuse cases rejected");
  assert.ok(v.split("exception when check_violation").length - 1 >= 6, "check violations are asserted");
});
