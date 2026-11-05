-- 004_shifts.sql: persisted weekly shift schedules (sede-week documents), shifts, history,
-- the SIESA code of each sede and the two write RPCs.
-- Apply manually in the Supabase SQL editor AFTER 001, 002 and 003, then re-run
-- db/seeds/sugerido_sedes.sql. Idempotent where practical.
-- Only the backend (service role) touches these objects: RLS on, no policies.
--
-- RPC error contract (raise exception message, mapped to HTTP by the API layer):
--   VERSION_CONFLICT   -> 409 (DETAIL = current version as text)
--   SHIFT_OVERLAP      -> 422 (DETAIL = jsonb array of conflicts as text)
--   SCHEDULE_NOT_FOUND -> 404 (publish of a week that was never saved)
--   INVALID_SHIFTS     -> 400 (payload outside the week / cedulas / duplicated key)
--
-- ROLLBACK: see db/migrations/rollback/004_shifts.down.sql. Copy of it:
--   drop function if exists shifts_publish_week(text, date, int, uuid);
--   drop function if exists shifts_save_week(text, date, int, text[], jsonb, uuid);
--   drop table if exists shift_history; drop table if exists shifts; drop table if exists sede_week_schedules;
--   drop index if exists sugerido_sedes_siesa_code_key;
--   alter table sugerido_sedes drop column if exists siesa_code;

-- ---------------------------------------------------------------------------
-- SIESA code per sede. The UPDATE is idempotent and a no-op on an empty catalog
-- (the seed fills it on a fresh database).
-- ---------------------------------------------------------------------------
alter table sugerido_sedes add column if not exists siesa_code text check (siesa_code ~ '^[0-9]{3,4}$');
create unique index if not exists sugerido_sedes_siesa_code_key on sugerido_sedes (siesa_code) where siesa_code is not null;
update sugerido_sedes s set siesa_code = v.code from (values
  ('copacabana','001'),('villahermosa','002'),('girardota-parque','003'),('girardota-llano','004'),
  ('barbosa','006'),('las-vegas','007'),('san-juan','008')) v(sede, code)
 where s.sede_id = v.sede and s.siesa_code is null;

-- ---------------------------------------------------------------------------
-- One document per (sede, ISO Monday). `version` is the optimistic-lock token.
-- ---------------------------------------------------------------------------
create table if not exists sede_week_schedules (
  id uuid primary key default gen_random_uuid(),
  sede_id text not null references sugerido_sedes (sede_id),
  week_start date not null check (extract(isodow from week_start) = 1),
  state text not null default 'BORRADOR' check (state in ('BORRADOR','PUBLICADO')),
  version int not null default 0 check (version >= 0),
  published_by uuid, published_at timestamptz,
  created_by uuid not null, created_at timestamptz not null default now(),
  updated_by uuid not null, updated_at timestamptz not null default now(),
  unique (sede_id, week_start), unique (id, sede_id),
  constraint sws_publish_chk check (
    (state = 'PUBLICADO' and published_at is not null and published_by is not null)
 or (state = 'BORRADOR'  and published_at is null     and published_by is null)));

create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null, sede_id text not null,
  siesa_code text,                          -- snapshot at write time, nullable
  cedula text not null check (cedula ~ '^[0-9]{5,15}$'),
  fecha date not null,                      -- Bogota wall-clock date of the START
  tipo text not null check (tipo in ('TRABAJO','DESCANSO','COMPENSATORIO')),
  start_time time, end_time time,           -- end <= start => next day; 24:00 allowed as end
  break_minutes int not null default 0 check (break_minutes between 0 and 480),
  lunch_start time,
  cargo text check (char_length(cargo) <= 120),
  observacion text check (char_length(observacion) <= 500),
  created_by uuid not null, created_at timestamptz not null default now(),
  updated_by uuid not null, updated_at timestamptz not null default now(),
  foreign key (schedule_id, sede_id) references sede_week_schedules (id, sede_id),
  unique (schedule_id, cedula, fecha),
  constraint shifts_kind_chk check (
    (tipo = 'TRABAJO' and start_time is not null and end_time is not null and start_time < time '24:00' and start_time <> end_time)
 or (tipo <> 'TRABAJO' and start_time is null and end_time is null and break_minutes = 0 and lunch_start is null)),
  constraint shifts_break_fits_chk check (tipo <> 'TRABAJO' or make_interval(mins => break_minutes) <
    case when end_time <= start_time then end_time - start_time + interval '24 hours' else end_time - start_time end));
create index if not exists shifts_cedula_fecha_idx on shifts (cedula, fecha);

create table if not exists shift_history (
  id bigint generated always as identity primary key,
  schedule_id uuid not null references sede_week_schedules (id),
  shift_id uuid,                            -- no FK: deleted shifts keep their history
  cedula text, fecha date,
  action text not null check (action in ('CREAR','EDITAR','ELIMINAR','EDITAR_PUBLICADO','PUBLICAR')),
  schedule_version int not null,            -- version AFTER the operation
  actor uuid not null, at timestamptz not null default now(),
  before jsonb, after jsonb,
  constraint sh_shape_chk check (
    (action = 'PUBLICAR' and shift_id is null and cedula is null and fecha is null and before is null and after is not null)
 or (action = 'CREAR'    and shift_id is not null and before is null and after is not null)
 or (action = 'EDITAR'   and shift_id is not null and before is not null and after is not null)
 or (action = 'ELIMINAR' and shift_id is not null and before is not null and after is null)
 or (action = 'EDITAR_PUBLICADO' and shift_id is not null and (before is not null or after is not null))));
create index if not exists shift_history_schedule_idx on shift_history (schedule_id, at desc, id desc);

alter table sede_week_schedules enable row level security;
alter table shifts enable row level security;
alter table shift_history enable row level security;
revoke all on table sede_week_schedules from anon, authenticated;
revoke all on table shifts from anon, authenticated;
revoke all on table shift_history from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Save: replaces the shifts of the SENT cedulas only, diffing on (cedula, fecha).
-- Unchanged rows are not touched (same id, no updated_*, no history).
-- ---------------------------------------------------------------------------
create or replace function shifts_save_week(
  p_sede text, p_week date, p_expected_version int, p_cedulas text[], p_shifts jsonb, p_actor uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_expected int := coalesce(p_expected_version, 0);
  v_sch sede_week_schedules;
  v_siesa text;
  v_published boolean;
  v_new_version int;
  v_conflicts jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('shifts:week:' || p_sede || ':' || to_char(p_week, 'YYYY-MM-DD')));
  -- Sorted and distinct, so two sedes locking overlapping cedulas cannot deadlock.
  perform pg_advisory_xact_lock(hashtext('shifts:cedula:' || c))
    from (select distinct unnest(p_cedulas) as c order by 1) x;

  select * into v_sch from sede_week_schedules where sede_id = p_sede and week_start = p_week for update;
  if not found then
    if v_expected > 0 then
      raise exception 'VERSION_CONFLICT' using detail = '0';
    end if;
    insert into sede_week_schedules (sede_id, week_start, created_by, updated_by)
    values (p_sede, p_week, p_actor, p_actor)
    returning * into v_sch;
  elsif v_sch.version <> v_expected then
    raise exception 'VERSION_CONFLICT' using detail = v_sch.version::text;
  end if;

  -- Defensive: the API validates this already.
  if exists (
       select 1 from jsonb_to_recordset(p_shifts) as x(cedula text, fecha date)
        where x.cedula is null or x.fecha is null or not (x.cedula = any(p_cedulas))
           or x.fecha < p_week or x.fecha > p_week + 6)
     or exists (
       select 1 from jsonb_to_recordset(p_shifts) as x(cedula text, fecha date)
        group by x.cedula, x.fecha having count(*) > 1) then
    raise exception 'INVALID_SHIFTS';
  end if;

  select siesa_code into v_siesa from sugerido_sedes where sede_id = p_sede;
  v_published := v_sch.state = 'PUBLICADO';
  v_new_version := v_sch.version + 1;

  with p as (
    select x.cedula, x.fecha, x.tipo, x.start_time, x.end_time,
           coalesce(x.break_minutes, case when x.tipo = 'TRABAJO' then 60 else 0 end) as break_minutes,
           x.lunch_start, x.cargo, x.observacion
      from jsonb_to_recordset(p_shifts) as x(
        cedula text, fecha date, tipo text, start_time time, end_time time,
        break_minutes int, lunch_start time, cargo text, observacion text)
  ),
  e as (
    select * from shifts where schedule_id = v_sch.id and cedula = any(p_cedulas)
  ),
  del as (
    delete from shifts s using e
     where s.id = e.id
       and not exists (select 1 from p where p.cedula = e.cedula and p.fecha = e.fecha)
    returning s.*
  ),
  upd as (
    update shifts s
       set tipo = p.tipo, start_time = p.start_time, end_time = p.end_time,
           break_minutes = p.break_minutes, lunch_start = p.lunch_start,
           cargo = p.cargo, observacion = p.observacion,
           siesa_code = v_siesa, updated_by = p_actor, updated_at = now()
      from p
     where s.schedule_id = v_sch.id and s.cedula = p.cedula and s.fecha = p.fecha
       and (s.tipo, s.start_time, s.end_time, s.break_minutes, s.lunch_start, s.cargo, s.observacion)
           is distinct from
           (p.tipo, p.start_time, p.end_time, p.break_minutes, p.lunch_start, p.cargo, p.observacion)
    returning s.*
  ),
  ins as (
    insert into shifts (schedule_id, sede_id, siesa_code, cedula, fecha, tipo, start_time, end_time,
                        break_minutes, lunch_start, cargo, observacion, created_by, updated_by)
    select v_sch.id, p_sede, v_siesa, p.cedula, p.fecha, p.tipo, p.start_time, p.end_time,
           p.break_minutes, p.lunch_start, p.cargo, p.observacion, p_actor, p_actor
      from p
     where not exists (select 1 from e where e.cedula = p.cedula and e.fecha = p.fecha)
    returning *
  )
  insert into shift_history (schedule_id, shift_id, cedula, fecha, action, schedule_version, actor, before, after)
  select v_sch.id, h.shift_id, h.cedula, h.fecha,
         case when v_published then 'EDITAR_PUBLICADO' else h.action end,
         v_new_version, p_actor, h.before, h.after
    from (
      select ins.id as shift_id, ins.cedula, ins.fecha, 'CREAR' as action, null::jsonb as before, to_jsonb(ins) as after from ins
      union all
      select upd.id, upd.cedula, upd.fecha, 'EDITAR', to_jsonb(e), to_jsonb(upd) from upd join e on e.id = upd.id
      union all
      select del.id, del.cedula, del.fecha, 'ELIMINAR', to_jsonb(del), null::jsonb from del
    ) h;

  -- Overlap, under the locks and after the writes: a violation rolls back rows AND history.
  with iv as (
    select s.id, s.schedule_id, s.cedula, s.sede_id, s.fecha, s.start_time, s.end_time,
           s.fecha + s.start_time as t0,
           s.fecha + s.end_time + case when s.end_time <= s.start_time then interval '1 day' else interval '0' end as t1
      from shifts s
     where s.tipo = 'TRABAJO' and s.cedula = any(p_cedulas) and s.fecha between p_week - 1 and p_week + 7)
  select jsonb_agg(jsonb_build_object('cedula', a.cedula, 'fecha', a.fecha, 'otherSedeId', b.sede_id,
         'otherFecha', b.fecha, 'otherStart', b.start_time, 'otherEnd', b.end_time))
    into v_conflicts
    from iv a join iv b on a.cedula = b.cedula and a.id <> b.id and a.t0 < b.t1 and a.t1 > b.t0
   where a.schedule_id = v_sch.id and (b.schedule_id <> v_sch.id or a.id < b.id);
  if v_conflicts is not null then
    raise exception 'SHIFT_OVERLAP' using detail = v_conflicts::text;
  end if;

  update sede_week_schedules
     set version = v_new_version, updated_by = p_actor, updated_at = now()
   where id = v_sch.id
  returning * into v_sch;

  return jsonb_build_object('id', v_sch.id, 'sedeId', v_sch.sede_id, 'weekStart', v_sch.week_start,
    'state', v_sch.state, 'version', v_sch.version,
    'publishedAt', v_sch.published_at, 'publishedBy', v_sch.published_by);
end
$$;

-- ---------------------------------------------------------------------------
-- Publish: BORRADOR -> PUBLICADO. Blockers (56 h, weekly rest) are evaluated by the API.
-- An already PUBLICADO week is a no-op.
-- ---------------------------------------------------------------------------
create or replace function shifts_publish_week(p_sede text, p_week date, p_expected_version int, p_actor uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_sch sede_week_schedules;
  v_noop boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext('shifts:week:' || p_sede || ':' || to_char(p_week, 'YYYY-MM-DD')));

  select * into v_sch from sede_week_schedules where sede_id = p_sede and week_start = p_week for update;
  if not found then
    raise exception 'SCHEDULE_NOT_FOUND';
  end if;

  if v_sch.state = 'PUBLICADO' then
    v_noop := true;
  else
    if v_sch.version <> coalesce(p_expected_version, 0) then
      raise exception 'VERSION_CONFLICT' using detail = v_sch.version::text;
    end if;
    update sede_week_schedules
       set state = 'PUBLICADO', published_by = p_actor, published_at = now(),
           version = version + 1, updated_by = p_actor, updated_at = now()
     where id = v_sch.id
    returning * into v_sch;
    insert into shift_history (schedule_id, action, schedule_version, actor, after)
    values (v_sch.id, 'PUBLICAR', v_sch.version, p_actor,
            jsonb_build_object('shifts',
              coalesce((select jsonb_agg(to_jsonb(s) order by s.cedula, s.fecha)
                          from shifts s where s.schedule_id = v_sch.id), '[]'::jsonb)));
  end if;

  return jsonb_build_object('id', v_sch.id, 'sedeId', v_sch.sede_id, 'weekStart', v_sch.week_start,
    'state', v_sch.state, 'version', v_sch.version,
    'publishedAt', v_sch.published_at, 'publishedBy', v_sch.published_by, 'noop', v_noop);
end
$$;

-- Executable by service_role only (Supabase grants EXECUTE on new functions to anon/authenticated).
revoke all on function shifts_save_week(text, date, int, text[], jsonb, uuid) from public;
revoke all on function shifts_publish_week(text, date, int, uuid) from public;
revoke all on function shifts_save_week(text, date, int, text[], jsonb, uuid) from anon, authenticated;
revoke all on function shifts_publish_week(text, date, int, uuid) from anon, authenticated;
grant execute on function shifts_save_week(text, date, int, text[], jsonb, uuid) to service_role;
grant execute on function shifts_publish_week(text, date, int, uuid) to service_role;
