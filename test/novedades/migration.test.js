import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static checks only: the migration is applied manually and never run by tests.
const sql = readFileSync(new URL("../../db/migrations/002_novedades.sql", import.meta.url), "utf8");
const norm = sql.toLowerCase().replace(/\s+/g, " ");
const sql001 = readFileSync(new URL("../../db/migrations/001_sugerido.sql", import.meta.url), "utf8");

const TIPOS = ["Incapacidades", "Licencias", "Vacaciones", "Permisos", "Estudio", "Día de la Familia"];

test("creates the novedades table with RLS enabled and no policies", () => {
  assert.match(norm, /create table (if not exists )?novedades \(/);
  assert.match(norm, /alter table novedades enable row level security/);
  assert.doesNotMatch(norm, /create policy/);
});

test("table privileges are revoked from anon and authenticated", () => {
  assert.ok(norm.includes("revoke all on table novedades from anon, authenticated"));
});

test("cedula is checked against the normalized digits-only format", () => {
  assert.match(norm, /cedula text not null check \(cedula ~ '\^\[0-9\]\{5,15\}\$'\)/);
});

test("tipo CHECK lists the 6 canonical strings exactly as seeded in 001 (NFC)", () => {
  const m = /tipo text not null check \(tipo in \(([^)]*)\)\)/.exec(sql.replace(/\s+/g, " "));
  assert.ok(m, "tipo check not found");
  const listed = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  assert.deepEqual(listed, TIPOS);
  for (const t of listed) assert.equal(t, t.normalize("NFC"));
  for (const t of TIPOS) assert.ok(sql001.includes(t), `001 does not seed ${t}`);
});

test("date range and cancellation consistency are enforced", () => {
  assert.match(norm, /fecha_inicio date not null/);
  assert.match(norm, /fecha_fin date not null/);
  assert.match(norm, /check \(fecha_fin >= fecha_inicio\)/);
  assert.match(norm, /anulada boolean not null default false/);
  assert.match(norm, /check \(anulada = \(anulada_at is not null\)\)/);
  for (const col of ["anulada_por", "anulada_at", "motivo_anulacion", "created_by", "updated_by", "created_at", "updated_at"]) {
    assert.match(norm, new RegExp(`${col} `), `missing column ${col}`);
  }
});

test("sede_id is a nullable FK to sugerido_sedes", () => {
  assert.match(norm, /sede_id text references sugerido_sedes ?\(sede_id\)/);
  assert.doesNotMatch(norm, /sede_id text not null/);
});

test("observacion is length-capped", () => {
  assert.match(norm, /check \(char_length\(observacion\) <= 1000\)/);
});

test("has the 3 indexes", () => {
  assert.match(norm, /create index (if not exists )?novedades_cedula_rango_idx on novedades \(cedula, fecha_inicio, fecha_fin\)/);
  assert.match(norm, /create index (if not exists )?novedades_sede_idx on novedades \(sede_id\)/);
  assert.match(norm, /create index (if not exists )?novedades_rango_idx on novedades \(fecha_inicio, fecha_fin\) where not anulada/);
});
