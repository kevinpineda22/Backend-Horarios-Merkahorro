import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static checks only: the migration is applied manually and never run by tests.
const read = (rel) => readFileSync(new URL(`../../db/${rel}`, import.meta.url), "utf8");
const sql = read("migrations/008_sugerido_registers.sql");
const down = read("migrations/rollback/008_sugerido_registers.down.sql");
const verify = read("verification/008_sugerido_registers_verify.sql");
const flat = (s) => s.toLowerCase().replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
const norm = flat(sql);

test("no file contains a NUL byte", () => {
  for (const s of [sql, down, verify]) assert.equal(s.includes("\u0000"), false);
});

test("registers_override is a nullable int added idempotently", () => {
  assert.ok(norm.includes("alter table sugerido_sedes add column if not exists registers_override int;"));
  assert.ok(!norm.includes("registers_override int not null"));
});

test("a named constraint limits the override to null or 1..50, dropped first so the script is re-runnable", () => {
  assert.ok(norm.includes("drop constraint if exists sugerido_sedes_registers_override_chk"));
  assert.match(norm, /add constraint sugerido_sedes_registers_override_chk check \(registers_override is null or registers_override between 1 and 50\)/);
});

test("RLS stays on, anon/authenticated stay closed and no policy is created", () => {
  assert.ok(norm.includes("alter table sugerido_sedes enable row level security"));
  assert.ok(norm.includes("revoke all on table sugerido_sedes from anon, authenticated"));
  assert.doesNotMatch(norm, /create policy/);
});

test("the header tells the operator to apply 008 before deploying", () => {
  assert.match(sql, /apply this BEFORE deploying the backend/i);
});

test("rollback snapshots the overrides first, then drops constraint and column", () => {
  const d = flat(down);
  assert.ok(d.indexOf("sugerido_sedes_registers_backup_008") < d.indexOf("drop column if exists registers_override"));
  assert.ok(d.includes("drop constraint if exists sugerido_sedes_registers_override_chk"));
  assert.ok(d.includes("drop column if exists registers_override"));
});

test("verify runs in one transaction that ends in ROLLBACK and checks the range", () => {
  const v = flat(verify).trim();
  assert.match(v, /^begin;/);
  assert.match(v, /rollback;$/);
  assert.ok(!/\bcommit\b/.test(v));
  assert.ok(v.includes("registers_override = 0") && v.includes("registers_override = 51"));
  assert.ok(v.includes("all checks passed"));
});

test("verify does not assume the table has no overrides (admins may have set some)", () => {
  assert.ok(!/registers_override is not null/.test(flat(verify)), "no data assertion on existing overrides");
});

test("information_schema lookups are scoped to the public schema", () => {
  for (const s of [flat(down), flat(verify)]) {
    const lookups = s.match(/from information_schema\.\w+ where [^)]*\)/g) ?? [];
    assert.ok(lookups.length > 0);
    for (const l of lookups) assert.ok(l.includes("table_schema = 'public'"), l);
  }
});
