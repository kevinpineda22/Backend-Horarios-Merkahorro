-- 001_sugerido.sql: cashier suggested-headcount module (sugerido-cajeras v1).
-- Applied MANUALLY in the Supabase SQL editor. Idempotent where practical.
-- Only the backend (service_role) touches these objects: RLS is enabled with
-- NO policies, so anon/authenticated clients can read and write nothing.

-- ---------------------------------------------------------------------------
-- Settings: one global row (id = 1), editable by admins through the API.
-- ---------------------------------------------------------------------------
create table if not exists sugerido_settings (
  id int primary key check (id = 1),
  ordinary_weekly_hours numeric not null default 42 check (ordinary_weekly_hours >= 0),
  overtime_weekly_hours numeric not null default 12 check (overtime_weekly_hours >= 0),
  daily_max_hours numeric not null default 10 check (daily_max_hours >= 0),
  utilization numeric not null default 0.85 check (utilization > 0 and utilization <= 1),
  max_working_days_per_week int not null default 6 check (max_working_days_per_week between 1 and 7),
  min_cashiers int not null default 1 check (min_cashiers >= 0),
  stale_after_days int not null default 1 check (stale_after_days >= 0),
  blocking_absence_types text[] not null
    default '{Incapacidades,Licencias,Vacaciones,Permisos,Estudio,"Día de la Familia"}',
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table sugerido_settings enable row level security;
insert into sugerido_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Sede mapping: app sede id -> SIESA bodegas and trazabilidad aliases.
-- ---------------------------------------------------------------------------
create table if not exists sugerido_sedes (
  sede_id text primary key,
  nombre text not null,
  bodegas text[] not null,
  trazabilidad_aliases text[] not null default '{}',
  activo boolean not null default true
);
alter table sugerido_sedes enable row level security;

-- ---------------------------------------------------------------------------
-- Runs (suggestion layer, immutable history) and their slots.
-- ---------------------------------------------------------------------------
create table if not exists sugerido_runs (
  id uuid primary key default gen_random_uuid(),
  sede_id text not null references sugerido_sedes (sede_id),
  week_start date not null check (extract(isodow from week_start) = 1),
  version int not null,
  method text not null,
  settings jsonb not null,
  inputs jsonb not null default '{}',
  flags jsonb not null default '{}',
  warnings jsonb not null default '[]',
  data_as_of date,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (sede_id, week_start, version)
);
alter table sugerido_runs enable row level security;

create table if not exists sugerido_slots (
  run_id uuid not null references sugerido_runs (id) on delete cascade,
  fecha date not null,
  franja time not null,
  forecast_docs numeric not null default 0,
  forecast_venta numeric not null default 0,
  required int,
  available int not null default 0,
  suggested int,
  shortfall int,
  status text not null default 'ok',
  primary key (run_id, fecha, franja)
);
alter table sugerido_slots enable row level security;

-- ---------------------------------------------------------------------------
-- Overrides (admin layer): survive recomputation, keyed by sede + slot.
-- ---------------------------------------------------------------------------
create table if not exists sugerido_overrides (
  sede_id text not null references sugerido_sedes (sede_id),
  fecha date not null,
  franja time not null,
  headcount int not null check (headcount >= 0),
  suggested_at_edit int,
  reason text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (sede_id, fecha, franja)
);
alter table sugerido_overrides enable row level security;

-- ---------------------------------------------------------------------------
-- Access: role and sede scope per user. sede_ids null = all sedes.
-- ---------------------------------------------------------------------------
create table if not exists sugerido_access (
  user_id uuid primary key,
  role text not null check (role in ('admin', 'planner', 'viewer')),
  sede_ids text[]
);
alter table sugerido_access enable row level security;

-- ---------------------------------------------------------------------------
-- sugerido_save_run: one transaction, version = max + 1 under an advisory
-- lock, so concurrent runs for the same sede/week cannot collide.
-- p_run:   { sede_id, week_start, method, settings, inputs, flags, warnings, data_as_of, created_by }
-- p_slots: [{ fecha, franja, forecast_docs, forecast_venta, required, available, suggested, shortfall, status }]
-- ---------------------------------------------------------------------------
create or replace function sugerido_save_run(p_run jsonb, p_slots jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_id uuid;
  v_ver int;
begin
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' or jsonb_array_length(p_slots) = 0 then
    raise exception 'sugerido_save_run: p_slots must be a non-empty array';
  end if;

  perform pg_advisory_xact_lock(hashtext((p_run->>'sede_id') || (p_run->>'week_start')));

  select coalesce(max(version), 0) + 1 into v_ver
    from sugerido_runs
   where sede_id = p_run->>'sede_id'
     and week_start = (p_run->>'week_start')::date;

  insert into sugerido_runs
    (sede_id, week_start, version, method, settings, inputs, flags, warnings, data_as_of, created_by)
  values (
    p_run->>'sede_id',
    (p_run->>'week_start')::date,
    v_ver,
    p_run->>'method',
    p_run->'settings',
    coalesce(p_run->'inputs', '{}'::jsonb),
    coalesce(p_run->'flags', '{}'::jsonb),
    coalesce(p_run->'warnings', '[]'::jsonb),
    nullif(p_run->>'data_as_of', '')::date,
    nullif(p_run->>'created_by', '')::uuid
  )
  returning id into v_id;

  insert into sugerido_slots
    (run_id, fecha, franja, forecast_docs, forecast_venta, required, available, suggested, shortfall, status)
  select v_id, s.fecha, s.franja, s.forecast_docs, s.forecast_venta,
         s.required, s.available, s.suggested, s.shortfall, s.status
    from jsonb_to_recordset(p_slots) as s(
      fecha date, franja time, forecast_docs numeric, forecast_venta numeric,
      required int, available int, suggested int, shortfall int, status text
    );

  return jsonb_build_object('id', v_id, 'version', v_ver);
end
$$;

-- ---------------------------------------------------------------------------
-- sugerido_apply_overrides: one transaction. headcount null = delete override.
-- p_items: [{ fecha, franja, headcount, suggested_at_edit, reason }]
-- ---------------------------------------------------------------------------
create or replace function sugerido_apply_overrides(p_sede text, p_items jsonb, p_user uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_deleted int;
  v_upserted int;
begin
  with items as (
    select * from jsonb_to_recordset(p_items) as i(
      fecha date, franja time, headcount int, suggested_at_edit int, reason text
    )
  ), del as (
    delete from sugerido_overrides o
     using items i
     where o.sede_id = p_sede and o.fecha = i.fecha and o.franja = i.franja
       and i.headcount is null
    returning 1
  )
  select count(*) into v_deleted from del;

  with items as (
    select * from jsonb_to_recordset(p_items) as i(
      fecha date, franja time, headcount int, suggested_at_edit int, reason text
    )
  ), up as (
    insert into sugerido_overrides
      (sede_id, fecha, franja, headcount, suggested_at_edit, reason, updated_by, updated_at)
    select p_sede, i.fecha, i.franja, i.headcount, i.suggested_at_edit, i.reason, p_user, now()
      from items i
     where i.headcount is not null
    on conflict (sede_id, fecha, franja) do update
      set headcount = excluded.headcount,
          suggested_at_edit = excluded.suggested_at_edit,
          reason = excluded.reason,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
    returning 1
  )
  select count(*) into v_upserted from up;

  return jsonb_build_object('upserted', v_upserted, 'deleted', v_deleted);
end
$$;

-- Functions are executable by service_role only (anon/authenticated revoked explicitly,
-- since Supabase default privileges grant them EXECUTE on new functions).
revoke all on function sugerido_save_run(jsonb, jsonb) from public;
revoke all on function sugerido_apply_overrides(text, jsonb, uuid) from public;
revoke all on function sugerido_save_run(jsonb, jsonb) from anon, authenticated;
revoke all on function sugerido_apply_overrides(text, jsonb, uuid) from anon, authenticated;
grant execute on function sugerido_save_run(jsonb, jsonb) to service_role;
grant execute on function sugerido_apply_overrides(text, jsonb, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Seed templates: edit the values, then uncomment and run.
-- ---------------------------------------------------------------------------
-- insert into sugerido_sedes (sede_id, nombre, bodegas, trazabilidad_aliases) values
--   ('<sede-id>', '<Sede name>', '{<siesa-bodega-code>}', '{<trazabilidad-sede-alias>}');
-- insert into sugerido_access (user_id, role, sede_ids) values
--   ('<supabase-auth-user-uuid>', 'admin', null);
