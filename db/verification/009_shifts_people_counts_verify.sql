-- 009_shifts_people_counts_verify.sql: manual verification. Run in the Supabase SQL editor AFTER 009. NEVER in tests.
-- One transaction that ends with ROLLBACK; a final "ALL CHECKS PASSED" notice means every check held.

begin;

do $$
declare
  v_sch uuid;
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
begin
  assert exists (select 1 from pg_proc where proname = 'shifts_people_counts'), 'function exists';
  assert not has_function_privilege('anon', 'shifts_people_counts(uuid[])', 'execute')
     and not has_function_privilege('authenticated', 'shifts_people_counts(uuid[])', 'execute'), 'anon/authenticated cannot execute';
  assert has_function_privilege('service_role', 'shifts_people_counts(uuid[])', 'execute'), 'service_role can execute';

  assert (select count(*) from shifts_people_counts(array[]::uuid[])) = 0, 'empty input -> no rows';

  insert into sugerido_sedes (sede_id, nombre, bodegas) values ('zz-verify-009', 'Verify 009', array['ZZ009']);
  insert into sede_week_schedules (sede_id, week_start, created_by, updated_by)
    values ('zz-verify-009', date '2031-01-06', v_actor, v_actor) returning id into v_sch;
  insert into shifts (schedule_id, sede_id, cedula, fecha, tipo, created_by, updated_by) values
    (v_sch, 'zz-verify-009', '99999991', date '2031-01-06', 'DESCANSO', v_actor, v_actor),
    (v_sch, 'zz-verify-009', '99999991', date '2031-01-07', 'DESCANSO', v_actor, v_actor),
    (v_sch, 'zz-verify-009', '99999992', date '2031-01-06', 'DESCANSO', v_actor, v_actor);

  assert (select people from shifts_people_counts(array[v_sch])) = 2, 'distinct cedulas: 3 rows, 2 people';
  assert (select count(*) from shifts_people_counts(array[gen_random_uuid()])) = 0, 'unknown schedule -> no row';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
