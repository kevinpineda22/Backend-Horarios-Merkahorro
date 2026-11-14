-- 013_publish_snapshots_verify.sql: manual verification. Run in the Supabase SQL editor AFTER 013. NEVER in tests.
-- One transaction that ends with ROLLBACK. A final "ALL CHECKS PASSED" notice means every check held.

begin;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
  v_schedule uuid;
begin
  assert (select relrowsecurity from pg_class where oid = 'schedule_publish_snapshots'::regclass), 'RLS enabled';
  assert not has_table_privilege('anon', 'schedule_publish_snapshots', 'select')
     and not has_table_privilege('authenticated', 'schedule_publish_snapshots', 'select'), 'anon/authenticated have no privileges';

  select id into v_schedule from sede_week_schedules limit 1;
  if v_schedule is null then
    raise notice 'No schedule saved yet: insert checks skipped';
  else
    insert into schedule_publish_snapshots (schedule_id, sede_id, week_start, schedule_version, published_by, recommendation, suggested, published)
    select id, sede_id, week_start, version, v_actor, null, null, '[]'::jsonb from sede_week_schedules where id = v_schedule;
    assert (select count(*) from schedule_publish_snapshots where published_by = v_actor) = 1, 'a snapshot can be stored';

    begin
      insert into schedule_publish_snapshots (schedule_id, sede_id, week_start, schedule_version, published_by, published)
      values (v_schedule, 'x', '2031-01-06', 1, v_actor, null);
      raise exception 'published must be required';
    exception when not_null_violation then null;
    end;
  end if;

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
