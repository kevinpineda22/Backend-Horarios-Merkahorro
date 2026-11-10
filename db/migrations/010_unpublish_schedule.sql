-- 010_unpublish_schedule.sql: "Despublicar" - return a PUBLICADO week to BORRADOR.
-- Apply manually in the Supabase SQL editor AFTER 004 and 005, then run db/verification/010_unpublish_schedule_verify.sql.
-- Idempotent. Only the backend (service role) touches these objects.
--
-- What changes:
--   * shift_history accepts a new action 'DESPUBLICAR' (schedule-level row like 'PUBLICAR': no shift, cedula or fecha;
--     `before` = {state, publishedAt, publishedBy}, `after` = {state: 'BORRADOR'}). The action CHECK and sh_shape_chk are
--     recreated; every existing row still satisfies them.
--   * shifts_unpublish_week(p_sede, p_week, p_expected_version, p_actor): same advisory lock + row lock as
--     shifts_publish_week, so it serializes with saves and publishes of the same week.
--       SCHEDULE_NOT_FOUND  no schedule for that sede/week
--       NOT_PUBLISHED       the week is BORRADOR
--       VERSION_CONFLICT    p_expected_version <> current version (detail = current version)
--       PAYROLL_CUT_PAID    a PAGADO payroll cut shares a day with the week (detail = cut id). ANULADO cuts do not block.
--     On success: state BORRADOR, version + 1, published_by / published_at NULL, shifts untouched, one history row.
--
-- DEPLOY: apply this BEFORE deploying the backend (POST .../unpublish calls the function). The old backend is unaffected.
-- ROLLBACK: db/migrations/rollback/010_unpublish_schedule.down.sql (removes the function and the DESPUBLICAR history rows).

-- ---------------------------------------------------------------------------
-- 1. History: allow the new action. The 004 action CHECK is unnamed, so find the CHECKs that mention 'PUBLICAR'.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'shift_history'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%PUBLICAR%'
  loop
    execute format('alter table shift_history drop constraint %I', c.conname);
  end loop;
end $$;

alter table shift_history add constraint shift_history_action_chk
  check (action in ('CREAR','EDITAR','ELIMINAR','EDITAR_PUBLICADO','PUBLICAR','DESPUBLICAR'));

alter table shift_history add constraint sh_shape_chk check (
    (action in ('PUBLICAR') and shift_id is null and cedula is null and fecha is null and before is null and after is not null)
 or (action = 'DESPUBLICAR' and shift_id is null and cedula is null and fecha is null and before is not null and after is not null)
 or (action = 'CREAR'    and shift_id is not null and before is null and after is not null)
 or (action = 'EDITAR'   and shift_id is not null and before is not null and after is not null)
 or (action = 'ELIMINAR' and shift_id is not null and before is not null and after is null)
 or (action = 'EDITAR_PUBLICADO' and shift_id is not null and (before is not null or after is not null)));

-- ---------------------------------------------------------------------------
-- 2. Unpublish: PUBLICADO -> BORRADOR.
-- ---------------------------------------------------------------------------
create or replace function shifts_unpublish_week(p_sede text, p_week date, p_expected_version int, p_actor uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_sch sede_week_schedules;
  v_before jsonb;
  v_cut bigint;
begin
  perform pg_advisory_xact_lock(hashtext('shifts:week:' || p_sede || ':' || to_char(p_week, 'YYYY-MM-DD')));

  select * into v_sch from sede_week_schedules where sede_id = p_sede and week_start = p_week for update;
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
    'state', v_sch.state, 'version', v_sch.version,
    'publishedAt', v_sch.published_at, 'publishedBy', v_sch.published_by);
end
$$;

-- Executable by service_role only (Supabase grants EXECUTE on new functions to anon/authenticated).
revoke all on function shifts_unpublish_week(text, date, int, uuid) from public;
revoke all on function shifts_unpublish_week(text, date, int, uuid) from anon, authenticated;
grant execute on function shifts_unpublish_week(text, date, int, uuid) to service_role;
