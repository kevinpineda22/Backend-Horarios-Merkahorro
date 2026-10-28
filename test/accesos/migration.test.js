import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static checks only: the migration is applied manually and never run by tests.
const sql = readFileSync(new URL("../../db/migrations/003_accesos.sql", import.meta.url), "utf8");
const norm = sql.toLowerCase().replace(/\s+/g, " ");

// Text of a `create or replace function <name>(...)` up to its closing `$$;`.
function fnBody(name) {
  const m = new RegExp(`create or replace function ${name}\\(([\\s\\S]*?)\\$\\$;`, "i").exec(sql);
  assert.ok(m, `function ${name} not found`);
  return m[0].toLowerCase().replace(/\s+/g, " ");
}

test("sugerido_access gets a uuid id backfilled for existing rows before it becomes the PK", () => {
  assert.match(norm, /alter table sugerido_access add column if not exists id uuid default gen_random_uuid\(\)/);
  assert.match(norm, /update sugerido_access set id = gen_random_uuid\(\) where id is null/);
  assert.match(norm, /alter column id set not null/);
});

test("PK swap is conditional, drops the user_id pkey and adds the id pkey without deleting rows", () => {
  assert.match(norm, /drop constraint sugerido_access_pkey/);
  assert.match(norm, /add constraint sugerido_access_pkey primary key \(id\)/);
  assert.match(norm, /alter column user_id set not null/);
  const codeOnly = sql.replace(/--[^\n]*/g, "").toLowerCase().replace(/\s+/g, " ");
  const addCol = codeOnly.indexOf("add column if not exists id uuid");
  const drop = codeOnly.indexOf("drop constraint sugerido_access_pkey");
  assert.ok(addCol >= 0 && drop > addCol, "id must exist before the old pkey is dropped");
  assert.doesNotMatch(norm, /delete from sugerido_access|truncate/);
  // No CASCADE on the pkey drop: dependents must make it fail loudly instead of vanishing.
  const code = sql.replace(/--[^\n]*/g, "").toLowerCase().replace(/\s+/g, " ");
  assert.match(code, /drop constraint sugerido_access_pkey;/);
  assert.doesNotMatch(code, /drop constraint[^;]*cascade/);
});

test("alias helper functions are closed to anon/authenticated (consistent with 001/002)", () => {
  for (const sig of ["sugerido_normalize_alias(text)", "sugerido_sync_sede_aliases()"]) {
    assert.ok(norm.includes(`revoke all on function ${sig} from public`), sig);
    assert.ok(norm.includes(`revoke all on function ${sig} from anon, authenticated`), sig);
  }
});

test("header documents the PRE-CHECK on pkey dependents and a ROLLBACK note", () => {
  const header = sql.slice(0, sql.indexOf("alter table sugerido_access add column"));
  assert.match(header, /PRE-CHECK/);
  assert.ok(
    header.replace(/\s+/g, " ").includes("select conname, conrelid::regclass from pg_constraint where confrelid = 'public.sugerido_access'::regclass;"),
  );
  assert.match(header, /ROLLBACK/);
});

test("audit and revoke columns are added idempotently", () => {
  for (const col of [
    "created_by uuid",
    "created_at timestamptz not null default now()",
    "updated_by uuid",
    "updated_at timestamptz not null default now()",
    "revoked_by uuid",
    "revoked_at timestamptz",
  ]) {
    assert.ok(norm.includes(`add column if not exists ${col}`), `missing ${col}`);
  }
});

test("partial unique index allows one ACTIVE row per user", () => {
  assert.match(
    norm,
    /create unique index if not exists sugerido_access_active_user_idx on sugerido_access \(user_id\) where revoked_at is null/,
  );
});

test("alias table is RLS-protected and closed to anon/authenticated", () => {
  assert.match(
    norm,
    /create table if not exists sugerido_sede_aliases \( alias text primary key, sede_id text not null references sugerido_sedes ?\(sede_id\)/,
  );
  assert.match(norm, /alter table sugerido_sede_aliases enable row level security/);
  assert.ok(norm.includes("revoke all on table sugerido_sede_aliases from anon, authenticated"));
  assert.ok(norm.includes("revoke all on table sugerido_access from anon, authenticated"));
  assert.doesNotMatch(norm, /create policy/);
});

test("alias normalization is lower + unaccent + collapsed spaces + trim", () => {
  assert.match(norm, /create extension if not exists unaccent/);
  const body = fnBody("sugerido_normalize_alias");
  assert.match(body, /lower\(unaccent\(btrim\(regexp_replace\(p_alias, '\\s\+', ' ', 'g'\)\)\)\)/);
});

test("trigger keeps aliases in sync with sugerido_sedes.trazabilidad_aliases and fails on collision", () => {
  assert.match(
    norm,
    /create trigger sugerido_sedes_sync_aliases after insert or update of trazabilidad_aliases on sugerido_sedes/,
  );
  const body = fnBody("sugerido_sync_sede_aliases");
  assert.match(body, /alias_collision/);
  assert.match(body, /delete from sugerido_sede_aliases where sede_id = new\.sede_id/);
  assert.match(body, /insert into sugerido_sede_aliases/);
  assert.match(norm, /drop trigger if exists sugerido_sedes_sync_aliases on sugerido_sedes/);
});

test("existing sedes are backfilled into the alias table", () => {
  assert.match(norm, /update sugerido_sedes set trazabilidad_aliases = trazabilidad_aliases/);
});

test("RPCs are security invoker, lock, and are service_role only", () => {
  for (const fn of ["sugerido_access_create", "sugerido_access_update", "sugerido_access_revoke"]) {
    const body = fnBody(fn);
    assert.match(body, /security invoker/);
    assert.match(body, /pg_advisory_xact_lock\(hashtext\('sugerido_access'\)\)/);
  }
  for (const sig of [
    "sugerido_access_create(uuid, text, text[], uuid)",
    "sugerido_access_update(uuid, text, text[], uuid)",
    "sugerido_access_revoke(uuid, uuid)",
  ]) {
    assert.ok(norm.includes(`revoke all on function ${sig} from public`), sig);
    assert.ok(norm.includes(`revoke all on function ${sig} from anon, authenticated`), sig);
    assert.ok(norm.includes(`grant execute on function ${sig} to service_role`), sig);
  }
});

test("create maps a duplicate active row to ACCESS_DUPLICATE", () => {
  const body = fnBody("sugerido_access_create");
  assert.match(body, /access_duplicate/);
  assert.match(body, /where user_id = p_user_id and revoked_at is null/);
});

test("update and revoke enforce LAST_ADMIN inside the transaction (self-downgrade allowed with another admin)", () => {
  for (const fn of ["sugerido_access_update", "sugerido_access_revoke"]) {
    const body = fnBody(fn);
    assert.match(body, /last_admin/);
    assert.match(body, /role = 'admin' and revoked_at is null and id <> p_id/, `${fn} must count OTHER active admins`);
    assert.match(
      body,
      /select \* into v_row from sugerido_access where id = p_id and revoked_at is null for update;/,
      `${fn} must lock the ACTIVE target row`,
    );
    assert.match(body, /access_not_found/);
    assert.match(body, /updated_by = p_actor/);
  }
  assert.match(
    fnBody("sugerido_access_update"),
    /if v_row\.role = 'admin' and p_role <> 'admin' and not exists \(select 1 from sugerido_access where role = 'admin' and revoked_at is null and id <> p_id\) then raise exception 'last_admin'/,
  );
  const rev = fnBody("sugerido_access_revoke");
  assert.match(
    rev,
    /if v_row\.role = 'admin' and not exists \(select 1 from sugerido_access where role = 'admin' and revoked_at is null and id <> p_id\) then raise exception 'last_admin'/,
  );
  assert.match(rev, /revoked_by = p_actor/);
  assert.match(rev, /revoked_at = now\(\)/);
  assert.doesNotMatch(rev, /delete from/);
});
