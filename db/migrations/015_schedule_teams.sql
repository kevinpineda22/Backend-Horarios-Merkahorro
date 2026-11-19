-- 015_schedule_teams.sql: one schedule per (sede, week, TEAM) instead of one per (sede, week).
-- Apply manually in the Supabase SQL editor AFTER 004, 009, 010, 013 and 014_shift_segments, then run
-- db/verification/015_schedule_teams_verify.sql. Idempotent. Only the backend (service role) touches these objects.
--
-- Why: a single sede-week document made every cargo share one version / state / publication, so publishing the
-- cashiers also published (and blocked on) everybody else. Each team now has its own document.
--
-- team_key values (the client sends it; the backend never derives membership from the employee directory):
--   'CAJEROS'                 the cashier team (existing rows are backfilled to it)
--   'CARGO:<CARGO>'           any other cargo, exactly as in the directory, trimmed and uppercased
--   'SIN_CARGO'               people without cargo
--
-- What changes:
--   * sede_week_schedules.team_key (not null, default 'CAJEROS', format CHECK). UNIQUE (sede_id, week_start) becomes
--     UNIQUE (sede_id, week_start, team_key); UNIQUE (id, sede_id) is kept (the shifts FK needs it).
--   * schedule_publish_snapshots.team_key (default 'CAJEROS'); its week index now includes the team.
--   * RPCs take p_team (third argument) and look the week up by (sede, week, team). The advisory lock key is
--     'shifts:week:<sede>:<week>:<team>'. Replaced: shifts_save_week (7 args + 8-arg segments wrapper),
--     shifts_publish_week (5 args + 6-arg segments wrapper), shifts_unpublish_week (5 args).
--   * DECISION: the previous signatures are DROPPED, not kept. Keeping them would let a stale backend keep writing into
--     the CAJEROS schedule without the cross-team guard; failing loudly (PGRST202 / 42883) is safer. So this migration
--     and the backend that calls p_team must be deployed together.
--   * Cross-team guard in shifts_save_week: a (cedula, fecha) that already exists in ANOTHER schedule of the same sede
--     and week (any team) is rejected, so payroll cannot count the same person-day twice.
--       SHIFT_IN_OTHER_TEAM -> 409 (DETAIL = jsonb array [{ cedula, fecha, otherTeamKey }])
--     Cross-sede overlap keeps being checked by the existing SHIFT_OVERLAP logic (it already reads every schedule).
--   * Everything else of 004 / 009 / 010 / 014 is preserved: history rows (EDITAR_PUBLICADO included), version bump,
--     paid-cut guard on unpublish, segments helper, and the two triggers (they act on rows, so they are team-agnostic).
--
-- ROLLBACK: db/migrations/rollback/015_schedule_teams.down.sql (refuses to run while a week has more than one team).

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
alter table sede_week_schedules add column if not exists team_key text not null default 'CAJEROS';

do $$
declare
  c record;
begin
  if not exists (select 1 from pg_constraint where conname = 'sws_team_key_chk' and conrelid = 'sede_week_schedules'::regclass) then
    alter table sede_week_schedules add constraint sws_team_key_chk
      check (char_length(team_key) between 1 and 120 and (team_key in ('CAJEROS', 'SIN_CARGO') or team_key like 'CARGO:_%'));
  end if;

  -- The 004 unique key is unnamed: find the one that covers exactly (sede_id, week_start).
  for c in
    select conname from pg_constraint
     where conrelid = 'sede_week_schedules'::regclass and contype = 'u'
       and pg_get_constraintdef(oid) = 'UNIQUE (sede_id, week_start)'
  loop
    execute format('alter table sede_week_schedules drop constraint %I', c.conname);
  end loop;

  if not exists (select 1 from pg_constraint where conname = 'sws_sede_week_team_key' and conrelid = 'sede_week_schedules'::regclass) then
    alter table sede_week_schedules add constraint sws_sede_week_team_key unique (sede_id, week_start, team_key);
  end if;
end $$;

alter table schedule_publish_snapshots add column if not exists team_key text not null default 'CAJEROS';

drop index if exists schedule_publish_snapshots_week_idx;
create index if not exists schedule_publish_snapshots_week_idx
  on schedule_publish_snapshots (sede_id, week_start, team_key, published_at desc);

-- ---------------------------------------------------------------------------
-- 2. Drop the pre-team signatures (see DECISION above). The segments helper and people counts are team-agnostic.
-- ---------------------------------------------------------------------------
drop function if exists shifts_save_week(text, date, int, text[], jsonb, uuid, jsonb);
drop function if exists shifts_save_week(text, date, int, text[], jsonb, uuid);
drop function if exists shifts_publish_week(text, date, int, uuid, jsonb);
drop function if exists shifts_publish_week(text, date, int, uuid);
drop function if exists shifts_unpublish_week(text, date, int, uuid);

-- ---------------------------------------------------------------------------
-- 3. Save: replaces the shifts of the SENT cedulas of ONE team schedule, diffing on (cedula, fecha).
-- ---------------------------------------------------------------------------
create or replace function shifts_save_week(
  p_sede text, p_week date, p_team text, p_expected_version int, p_cedulas text[], p_shifts jsonb, p_actor uuid)
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
  perform pg_advisory_xact_lock(hashtext('shifts:week:' || p_sede || ':' || to_char(p_week, 'YYYY-MM-DD') || ':' || p_team));
  -- Sorted and distinct, so two sedes (or two teams) locking overlapping cedulas cannot deadlock.
  perform pg_advisory_xact_lock(hashtext('shifts:cedula:' || c))
    from (select distinct unnest(p_cedulas) as c order by 1) x;

  select * into v_sch from sede_week_schedules
   where sede_id = p_sede and week_start = p_week and team_key = p_team for update;
  if not found then
    if v_expected > 0 then
      raise exception 'VERSION_CONFLICT' using detail = '0';
    end if;
    insert into sede_week_schedules (sede_id, week_start, team_key, created_by, updated_by)
    values (p_sede, p_week, p_team, p_actor, p_actor)
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

  -- Cross-team guard: one person-day lives in ONE team of the sede-week (payroll would count it twice). Under the
  -- cedula locks, so two teams saving the same person at once cannot both pass.
  select jsonb_agg(jsonb_build_object('cedula', s.cedula, 'fecha', s.fecha, 'otherTeamKey', o.team_key)
                   order by s.cedula, s.fecha)
    into v_conflicts
    from jsonb_to_recordset(p_shifts) as x(cedula text, fecha date)
    join shifts s on s.cedula = x.cedula and s.fecha = x.fecha
    join sede_week_schedules o on o.id = s.schedule_id
   where o.sede_id = p_sede and o.week_start = p_week and o.id <> v_sch.id;
  if v_conflicts is not null then
    raise exception 'SHIFT_IN_OTHER_TEAM' using detail = v_conflicts::text;
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

  -- Overlap, under the locks and after the writes: a violation rolls back rows AND history. It reads every schedule
  -- (other sedes AND other teams), so cross-sede overlaps keep being caught.
  v_conflicts := null;
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
    'teamKey', v_sch.team_key, 'state', v_sch.state, 'version', v_sch.version,
    'publishedAt', v_sch.published_at, 'publishedBy', v_sch.published_by);
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Publish: BORRADOR -> PUBLICADO for ONE team schedule. Blockers are evaluated by the API.
-- ---------------------------------------------------------------------------
create or replace function shifts_publish_week(
  p_sede text, p_week date, p_team text, p_expected_version int, p_actor uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_sch sede_week_schedules;
  v_noop boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext('shifts:week:' || p_sede || ':' || to_char(p_week, 'YYYY-MM-DD') || ':' || p_team));

  select * into v_sch from sede_week_schedules
   where sede_id = p_sede and week_start = p_week and team_key = p_team for update;
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
    'teamKey', v_sch.team_key, 'state', v_sch.state, 'version', v_sch.version,
    'publishedAt', v_sch.published_at, 'publishedBy', v_sch.published_by, 'noop', v_noop);
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Unpublish: PUBLICADO -> BORRADOR for ONE team schedule (paid-cut guard as in 010).
-- ---------------------------------------------------------------------------
create or replace function shifts_unpublish_week(
  p_sede text, p_week date, p_team text, p_expected_version int, p_actor uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_sch sede_week_schedules;
  v_before jsonb;
  v_cut bigint;
begin
  perform pg_advisory_xact_lock(hashtext('shifts:week:' || p_sede || ':' || to_char(p_week, 'YYYY-MM-DD') || ':' || p_team));

  select * into v_sch from sede_week_schedules
   where sede_id = p_sede and week_start = p_week and team_key = p_team for update;
  if not found then
    raise exception 'SCHEDULE_NOT_FOUND';
  end if;
  if v_sch.state <> 'PUBLICADO' then
    raise exception 'NOT_PUBLISHED';
  end if;
  if v_sch.version <> coalesce(p_expected_version, 0) then
    raise exception 'VERSION_CONFLICT' using detail = v_sch.version::text;
  end if;

  -- A paid payroll cut already priced this week: it cannot go back to draft. Voided (ANULADO) cuts do not count.
  select id into v_cut from payroll_cuts
   where state = 'PAGADO' and period_start <= p_week + 6 and period_end >= p_week
   order by id limit 1;
  if found then
    raise exception 'PAYROLL_CUT_PAID' using detail = v_cut::text;
  end if;

  v_before := jsonb_build_object('state', v_sch.state, 'publishedAt', v_sch.published_at, 'publishedBy', v_sch.published_by);

  update sede_week_schedules
     set state = 'BORRADOR', published_by = null, published_at = null,
         version = version + 1, updated_by = p_actor, updated_at = now()
   where id = v_sch.id
  returning * into v_sch;

  insert into shift_history (schedule_id, action, schedule_version, actor, before, after)
  values (v_sch.id, 'DESPUBLICAR', v_sch.version, p_actor, v_before, jsonb_build_object('state', 'BORRADOR'));

  return jsonb_build_object('id', v_sch.id, 'sedeId', v_sch.sede_id, 'weekStart', v_sch.week_start,
    'teamKey', v_sch.team_key, 'state', v_sch.state, 'version', v_sch.version,
    'publishedAt', v_sch.published_at, 'publishedBy', v_sch.published_by);
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Segments wrappers (014): same atomic publish/save + segments, now per team.
-- ---------------------------------------------------------------------------
create or replace function shifts_publish_week(
  p_sede text, p_week date, p_team text, p_expected_version int, p_actor uuid, p_segments jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_result jsonb;
begin
  v_result := shifts_publish_week(p_sede, p_week, p_team, p_expected_version, p_actor);
  if not coalesce((v_result ->> 'noop')::boolean, false) then
    perform shifts_apply_segments((v_result ->> 'id')::uuid, null, p_segments);
  end if;
  return v_result;
end
$$;

create or replace function shifts_save_week(
  p_sede text, p_week date, p_team text, p_expected_version int, p_cedulas text[], p_shifts jsonb, p_actor uuid, p_segments jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_result jsonb;
begin
  v_result := shifts_save_week(p_sede, p_week, p_team, p_expected_version, p_cedulas, p_shifts, p_actor);
  if v_result ->> 'state' = 'PUBLICADO' then
    perform shifts_apply_segments((v_result ->> 'id')::uuid, p_cedulas, p_segments);
  end if;
  return v_result;
end
$$;

-- Executable by service_role only (Supabase grants EXECUTE on new functions to anon/authenticated).
revoke all on function shifts_save_week(text, date, text, int, text[], jsonb, uuid) from public;
revoke all on function shifts_save_week(text, date, text, int, text[], jsonb, uuid, jsonb) from public;
revoke all on function shifts_publish_week(text, date, text, int, uuid) from public;
revoke all on function shifts_publish_week(text, date, text, int, uuid, jsonb) from public;
revoke all on function shifts_unpublish_week(text, date, text, int, uuid) from public;
revoke all on function shifts_save_week(text, date, text, int, text[], jsonb, uuid) from anon, authenticated;
revoke all on function shifts_save_week(text, date, text, int, text[], jsonb, uuid, jsonb) from anon, authenticated;
revoke all on function shifts_publish_week(text, date, text, int, uuid) from anon, authenticated;
revoke all on function shifts_publish_week(text, date, text, int, uuid, jsonb) from anon, authenticated;
revoke all on function shifts_unpublish_week(text, date, text, int, uuid) from anon, authenticated;
grant execute on function shifts_save_week(text, date, text, int, text[], jsonb, uuid) to service_role;
grant execute on function shifts_save_week(text, date, text, int, text[], jsonb, uuid, jsonb) to service_role;
grant execute on function shifts_publish_week(text, date, text, int, uuid) to service_role;
grant execute on function shifts_publish_week(text, date, text, int, uuid, jsonb) to service_role;
grant execute on function shifts_unpublish_week(text, date, text, int, uuid) to service_role;
