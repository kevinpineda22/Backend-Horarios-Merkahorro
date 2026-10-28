-- 003_accesos.sql: access administration + sede alias table.
-- Apply manually in the Supabase SQL editor AFTER 001 and 002. Idempotent where practical.
-- Only the backend (service role) touches these objects: RLS on, no policies.
--
-- RPC error contract (raise exception message, mapped to HTTP by the API layer):
--   ACCESS_DUPLICATE  -> 409 (user already has an active row)
--   LAST_ADMIN        -> 409 (change would leave zero active admins)
--   ACCESS_NOT_FOUND  -> 404 (no ACTIVE row with that id)
--   ALIAS_COLLISION   -> raised by the alias trigger when an alias maps to two sedes
--
-- PRE-CHECK (run FIRST, expected: no rows). Lists objects depending on the current
-- sugerido_access primary key; the pkey drop below has no CASCADE and fails if any exist:
--   select conname, conrelid::regclass from pg_constraint where confrelid = 'public.sugerido_access'::regclass;
--
-- ROLLBACK (valid only before any row is revoked, i.e. while every row has revoked_at null):
--   drop function if exists sugerido_access_create(uuid, text, text[], uuid);
--   drop function if exists sugerido_access_update(uuid, text, text[], uuid);
--   drop function if exists sugerido_access_revoke(uuid, uuid);
--   drop trigger if exists sugerido_sedes_sync_aliases on sugerido_sedes;
--   drop function if exists sugerido_sync_sede_aliases();
--   drop function if exists sugerido_normalize_alias(text);
--   drop table if exists sugerido_sede_aliases;
--   drop index if exists sugerido_access_active_user_idx;
--   alter table sugerido_access drop constraint sugerido_access_pkey;
--   alter table sugerido_access add constraint sugerido_access_pkey primary key (user_id);
--   alter table sugerido_access drop column id, drop column created_by, drop column created_at,
--     drop column updated_by, drop column updated_at, drop column revoked_by, drop column revoked_at;

-- ---------------------------------------------------------------------------
-- sugerido_access: surrogate id PK, audit columns, soft revoke.
-- Existing rows (e.g. the bootstrap admin) are preserved: the new id column is
-- added with a volatile default, so every existing row receives its own uuid.
-- ---------------------------------------------------------------------------
alter table sugerido_access add column if not exists id uuid default gen_random_uuid();
update sugerido_access set id = gen_random_uuid() where id is null;
alter table sugerido_access alter column id set not null;

do $$
begin
  -- Swap the PK only while it is still on user_id (re-runs are no-ops).
  if exists (
    select 1 from pg_constraint
    where conrelid = 'sugerido_access'::regclass
      and conname = 'sugerido_access_pkey'
      and contype = 'p'
      and conkey = array[(select attnum from pg_attribute
                          where attrelid = 'sugerido_access'::regclass and attname = 'user_id')]
  ) then
    alter table sugerido_access drop constraint sugerido_access_pkey;
    alter table sugerido_access add constraint sugerido_access_pkey primary key (id);
  end if;
end
$$;

alter table sugerido_access alter column user_id set not null;
alter table sugerido_access add column if not exists created_by uuid;
alter table sugerido_access add column if not exists created_at timestamptz not null default now();
alter table sugerido_access add column if not exists updated_by uuid;
alter table sugerido_access add column if not exists updated_at timestamptz not null default now();
alter table sugerido_access add column if not exists revoked_by uuid;
alter table sugerido_access add column if not exists revoked_at timestamptz;

-- One ACTIVE row per user; revoked rows stay as history.
create unique index if not exists sugerido_access_active_user_idx
  on sugerido_access (user_id) where revoked_at is null;

alter table sugerido_access enable row level security;
revoke all on table sugerido_access from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Sede aliases: normalized alias -> sede. Kept in sync by a trigger from
-- sugerido_sedes.trazabilidad_aliases. The JS twin is src/shared/sedeAlias.js.
-- ---------------------------------------------------------------------------
create extension if not exists unaccent;

create or replace function sugerido_normalize_alias(p_alias text)
returns text
language sql
stable
as $$
  select lower(unaccent(btrim(regexp_replace(p_alias, '\s+', ' ', 'g'))))
$$;

create table if not exists sugerido_sede_aliases (
  alias text primary key,
  sede_id text not null references sugerido_sedes (sede_id) on delete cascade
);
alter table sugerido_sede_aliases enable row level security;
revoke all on table sugerido_sede_aliases from anon, authenticated;

create or replace function sugerido_sync_sede_aliases()
returns trigger
language plpgsql
security invoker
as $$
declare
  v_alias text;
  v_other text;
begin
  perform pg_advisory_xact_lock(hashtext('sugerido_sede_aliases'));
  delete from sugerido_sede_aliases where sede_id = new.sede_id;
  for v_alias in
    select distinct sugerido_normalize_alias(t.a)
    from unnest(coalesce(new.trazabilidad_aliases, '{}')) as t(a)
    where sugerido_normalize_alias(t.a) <> ''
  loop
    select sede_id into v_other from sugerido_sede_aliases where alias = v_alias;
    if found then
      raise exception 'ALIAS_COLLISION: alias "%" is already mapped to sede %', v_alias, v_other
        using errcode = '23505';
    end if;
    insert into sugerido_sede_aliases (alias, sede_id) values (v_alias, new.sede_id);
  end loop;
  return new;
end
$$;

drop trigger if exists sugerido_sedes_sync_aliases on sugerido_sedes;
create trigger sugerido_sedes_sync_aliases
  after insert or update of trazabilidad_aliases on sugerido_sedes
  for each row execute function sugerido_sync_sede_aliases();

-- Backfill: re-fires the trigger for every existing sede (fails on an ambiguous alias).
update sugerido_sedes set trazabilidad_aliases = trazabilidad_aliases;

-- ---------------------------------------------------------------------------
-- Access RPCs: one transaction each, serialized by an advisory lock, so the
-- LAST_ADMIN count and the duplicate check cannot race.
-- ---------------------------------------------------------------------------
create or replace function sugerido_access_create(p_user_id uuid, p_role text, p_sede_ids text[], p_actor uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_row sugerido_access;
begin
  perform pg_advisory_xact_lock(hashtext('sugerido_access'));
  if exists (select 1 from sugerido_access where user_id = p_user_id and revoked_at is null) then
    raise exception 'ACCESS_DUPLICATE' using errcode = '23505';
  end if;
  insert into sugerido_access (user_id, role, sede_ids, created_by, updated_by)
  values (p_user_id, p_role, p_sede_ids, p_actor, p_actor)
  returning * into v_row;
  return to_jsonb(v_row);
end
$$;

-- Role / scope change. Demoting the last active admin (including self-downgrade) -> LAST_ADMIN.
create or replace function sugerido_access_update(p_id uuid, p_role text, p_sede_ids text[], p_actor uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_row sugerido_access;
begin
  perform pg_advisory_xact_lock(hashtext('sugerido_access'));
  select * into v_row from sugerido_access where id = p_id and revoked_at is null for update;
  if not found then
    raise exception 'ACCESS_NOT_FOUND';
  end if;
  if v_row.role = 'admin' and p_role <> 'admin'
     and not exists (select 1 from sugerido_access
                     where role = 'admin' and revoked_at is null and id <> p_id) then
    raise exception 'LAST_ADMIN';
  end if;
  update sugerido_access
     set role = p_role, sede_ids = p_sede_ids, updated_by = p_actor, updated_at = now()
   where id = p_id
  returning * into v_row;
  return to_jsonb(v_row);
end
$$;

-- Soft revoke: the row is kept for audit; access is lost immediately.
create or replace function sugerido_access_revoke(p_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_row sugerido_access;
begin
  perform pg_advisory_xact_lock(hashtext('sugerido_access'));
  select * into v_row from sugerido_access where id = p_id and revoked_at is null for update;
  if not found then
    raise exception 'ACCESS_NOT_FOUND';
  end if;
  if v_row.role = 'admin'
     and not exists (select 1 from sugerido_access
                     where role = 'admin' and revoked_at is null and id <> p_id) then
    raise exception 'LAST_ADMIN';
  end if;
  update sugerido_access
     set revoked_by = p_actor, revoked_at = now(), updated_by = p_actor, updated_at = now()
   where id = p_id
  returning * into v_row;
  return to_jsonb(v_row);
end
$$;

-- Alias helpers: not callable by anon/authenticated (consistent with 001/002).
revoke all on function sugerido_normalize_alias(text) from public;
revoke all on function sugerido_normalize_alias(text) from anon, authenticated;
revoke all on function sugerido_sync_sede_aliases() from public;
revoke all on function sugerido_sync_sede_aliases() from anon, authenticated;

-- Executable by service_role only (Supabase grants EXECUTE on new functions to anon/authenticated).
revoke all on function sugerido_access_create(uuid, text, text[], uuid) from public;
revoke all on function sugerido_access_update(uuid, text, text[], uuid) from public;
revoke all on function sugerido_access_revoke(uuid, uuid) from public;
revoke all on function sugerido_access_create(uuid, text, text[], uuid) from anon, authenticated;
revoke all on function sugerido_access_update(uuid, text, text[], uuid) from anon, authenticated;
revoke all on function sugerido_access_revoke(uuid, uuid) from anon, authenticated;
grant execute on function sugerido_access_create(uuid, text, text[], uuid) to service_role;
grant execute on function sugerido_access_update(uuid, text, text[], uuid) to service_role;
grant execute on function sugerido_access_revoke(uuid, uuid) to service_role;
