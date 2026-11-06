-- 005_payroll_cuts_verify.sql: manual verification of the payroll cut tables and RPCs.
-- Run in the Supabase SQL editor AFTER 005_payroll_cuts.sql. NEVER run it as part of tests.
-- It works in far-future periods (2031), runs everything inside ONE transaction and ends with
-- ROLLBACK, so nothing is kept. Expected failures are caught in nested BEGIN/EXCEPTION blocks
-- (each one is a savepoint), so a raise that is part of a check does not abort the rest. A failed
-- check raises and stops the script; a final "ALL CHECKS PASSED" notice means every check held.
--
-- Note: the SQL editor may run the whole script in one batch. If your editor auto-commits each
-- statement, run it from a psql session instead (begin/rollback are explicit below).

begin;

-- Snapshot builder (temporary, dies with the transaction): p_weeks weeks, every line scaled by p_scale.
-- Per week: worked 5, extras 1, nocturnas 0.5, dominicales 1.5, festivos 0 (times p_scale).
create function pg_temp.vsnap(p_from date, p_weeks int, p_cedulas text[], p_scale numeric default 1)
returns jsonb language sql as $$
  select jsonb_build_object(
    'sundays', jsonb_build_array((p_from + 6)::text),
    'holidays', '[]'::jsonb,
    'engineVersion', '1',
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'cedula', c, 'nombre', 'Test ' || c, 'cargo', 'Cajero', 'sede_id', 'copacabana',
        'siesa_code', '001', 'branch_source', 'shift', 'in_directory', true,
        'worked_hours', 5 * p_weeks * p_scale, 'extras', 1 * p_weeks * p_scale,
        'nocturnas', 0.5 * p_weeks * p_scale, 'dominicales', 1.5 * p_weeks * p_scale,
        'festivos', 0, 'sunday_festive_hours', 0,
        'weeks', (
          select jsonb_agg(jsonb_build_object(
            'week_start', (p_from + 7 * g)::text, 'worked_hours', 5 * p_scale, 'extras', 1 * p_scale,
            'nocturnas', 0.5 * p_scale, 'dominicales', 1.5 * p_scale, 'festivos', 0,
            'sunday_festive_hours', 0, 'has_overlap', false))
          from generate_series(0, p_weeks - 1) g)))
      from unnest(p_cedulas) c), '[]'::jsonb));
$$;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
  v_from  date := date '2031-01-06';   -- Monday
  v_res jsonb;
  v_id bigint;
  v_n int;
begin
  -- 1. Save a 14-day cut: totals are the exact sum of the lines, employees = lines, history CREAR.
  v_res := payroll_cut_save(v_from, v_from + 13, pg_temp.vsnap(v_from, 2, array['11111111','22222222']), v_actor);
  v_id := (v_res->>'id')::bigint;
  assert v_res->>'state' = 'PAGADO', 'a new cut is PAGADO';
  assert (v_res->>'employees')::int = 2, 'employees = number of lines';
  assert (v_res->>'extras')::numeric = 4 and (v_res->>'dominicales')::numeric = 6, 'totals are the sum of the lines';
  assert (select count(*) from payroll_cut_lines where cut_id = v_id) = 2, 'two lines';
  assert (select count(*) from payroll_cut_weeks where cut_id = v_id) = 4, 'two weeks per line';
  assert (select count(*) from payroll_cut_history where cut_id = v_id and action = 'CREAR') = 1, 'one CREAR history row';
  assert (select siesa_code from payroll_cut_lines where cut_id = v_id and cedula = '11111111') = '001', 'siesa_code snapshot';

  -- 2. Overlap with a PAGADO cut raises PAYROLL_CUT_OVERLAP and persists nothing.
  select count(*) into v_n from payroll_cuts where period_start >= date '2031-01-01';
  begin
    perform payroll_cut_save(v_from + 7, v_from + 13, pg_temp.vsnap(v_from + 7, 1, array['33333333']), v_actor);
    raise exception 'expected PAYROLL_CUT_OVERLAP';
  exception when others then
    assert sqlerrm = 'PAYROLL_CUT_OVERLAP', 'overlap must raise PAYROLL_CUT_OVERLAP, got ' || sqlerrm;
  end;
  assert (select count(*) from payroll_cuts where period_start >= date '2031-01-01') = v_n, 'overlap must persist nothing';
  assert (select count(*) from payroll_cut_lines where cedula = '33333333') = 0, 'overlap must leave no lines';

  -- 3. The EXCLUDE constraint is the real guarantee: a direct overlapping PAGADO insert fails with 23P01.
  begin
    insert into payroll_cuts (period_start, period_end, employees, extras, nocturnas, dominicales, festivos,
                              sundays, holidays, engine_version, created_by)
    values (v_from + 7, v_from + 13, 0, 0, 0, 0, 0, '[]', '[]', '1', v_actor);
    raise exception 'expected 23P01';
  exception when others then
    assert sqlstate = '23P01', 'direct overlapping insert must fail with 23P01, got ' || sqlstate;
  end;

  -- 4. Void: soft, records who and when, reason optional; a second void and a missing id raise.
  v_res := payroll_cut_void(v_id, null, v_actor);
  assert v_res->>'state' = 'ANULADO' and v_res->>'voided_at' is not null, 'void sets ANULADO and voided_at';
  assert (v_res->>'voided_by')::uuid = v_actor, 'void records who';
  assert (select count(*) from payroll_cut_history where cut_id = v_id and action = 'ANULAR') = 1, 'one ANULAR history row';
  assert (select count(*) from payroll_cut_lines where cut_id = v_id) = 2, 'a void keeps the snapshot';
  begin
    perform payroll_cut_void(v_id, 'again', v_actor);
    raise exception 'expected PAYROLL_CUT_ALREADY_VOID';
  exception when others then
    assert sqlerrm = 'PAYROLL_CUT_ALREADY_VOID', 'second void must raise PAYROLL_CUT_ALREADY_VOID, got ' || sqlerrm;
  end;
  begin
    perform payroll_cut_void(9223372036854775807, 'x', v_actor);
    raise exception 'expected PAYROLL_CUT_NOT_FOUND';
  exception when others then
    assert sqlerrm = 'PAYROLL_CUT_NOT_FOUND', 'unknown id must raise PAYROLL_CUT_NOT_FOUND, got ' || sqlerrm;
  end;

  -- 5. A voided cut frees its dates: the same period can be saved again; the adjacent period is free too.
  v_res := payroll_cut_save(v_from, v_from + 13, pg_temp.vsnap(v_from, 2, array['11111111']), v_actor);
  assert (v_res->>'id')::bigint <> v_id, 're-save creates a new cut';
  perform payroll_cut_save(v_from + 14, v_from + 20, pg_temp.vsnap(v_from + 14, 1, array['11111111']), v_actor);
  v_res := payroll_cut_void((v_res->>'id')::bigint, 'with a reason', v_actor);
  assert v_res->>'void_reason' = 'with a reason', 'void reason is stored';

  -- 6. Zero-hour employees are stored: employees counts every line.
  v_res := payroll_cut_save(date '2031-02-10', date '2031-02-16',
    pg_temp.vsnap(date '2031-02-10', 1, array['44444444','55555555'], 0), v_actor);
  assert (v_res->>'employees')::int = 2 and (v_res->>'extras')::numeric = 0, 'zero-hour lines are counted and stored';
end
$$;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
  v_bad date := date '2031-03-03';     -- Monday, never used above
  v_snap jsonb;
  v_cuts int;
  v_lines int;
begin
  select count(*) into v_cuts from payroll_cuts;
  select count(*) into v_lines from payroll_cut_lines;

  -- 7. Bad snapshots raise INVALID_SNAPSHOT and leave no rows.
  -- A line missing the second week.
  v_snap := pg_temp.vsnap(v_bad, 2, array['66666666']);
  v_snap := jsonb_set(v_snap, '{lines,0,weeks}', (v_snap #> '{lines,0,weeks}') - 1);
  begin
    perform payroll_cut_save(v_bad, v_bad + 13, v_snap, v_actor);
    raise exception 'expected INVALID_SNAPSHOT';
  exception when others then
    assert sqlerrm = 'INVALID_SNAPSHOT', 'missing week must raise INVALID_SNAPSHOT, got ' || sqlerrm;
  end;
  -- Duplicated cedula.
  begin
    perform payroll_cut_save(v_bad, v_bad + 6, pg_temp.vsnap(v_bad, 1, array['66666666','66666666']), v_actor);
    raise exception 'expected INVALID_SNAPSHOT';
  exception when others then
    assert sqlerrm = 'INVALID_SNAPSHOT', 'duplicated cedula must raise INVALID_SNAPSHOT, got ' || sqlerrm;
  end;
  -- A period that is not Monday-Sunday.
  begin
    perform payroll_cut_save(v_bad + 1, v_bad + 7, pg_temp.vsnap(v_bad + 1, 1, array['66666666']), v_actor);
    raise exception 'expected INVALID_SNAPSHOT';
  exception when others then
    assert sqlerrm = 'INVALID_SNAPSHOT', 'bad period must raise INVALID_SNAPSHOT, got ' || sqlerrm;
  end;
  -- A line violating a table check (negative hours) fails AFTER the cut insert: everything rolls back.
  v_snap := jsonb_set(pg_temp.vsnap(v_bad, 1, array['66666666']), '{lines,0,extras}', '-1');
  begin
    perform payroll_cut_save(v_bad, v_bad + 6, v_snap, v_actor);
    raise exception 'expected a check violation';
  exception when others then
    assert sqlstate = '23514', 'negative hours must fail with 23514, got ' || sqlstate;
  end;
  assert (select count(*) from payroll_cuts) = v_cuts, 'bad snapshots must leave no cut rows';
  assert (select count(*) from payroll_cut_lines) = v_lines, 'bad snapshots must leave no line rows';
  assert not exists (select 1 from payroll_cuts where period_start = v_bad), 'no cut for the bad period';
end
$$;

do $$
declare
  t text;
begin
  -- 8. Privileges: only service_role may execute the RPCs; anon/authenticated cannot touch the tables.
  assert not has_function_privilege('anon', 'payroll_cut_save(date, date, jsonb, uuid)', 'EXECUTE'), 'anon must not execute save';
  assert not has_function_privilege('authenticated', 'payroll_cut_save(date, date, jsonb, uuid)', 'EXECUTE'), 'authenticated must not execute save';
  assert not has_function_privilege('anon', 'payroll_cut_void(bigint, text, uuid)', 'EXECUTE'), 'anon must not execute void';
  assert not has_function_privilege('authenticated', 'payroll_cut_void(bigint, text, uuid)', 'EXECUTE'), 'authenticated must not execute void';
  assert has_function_privilege('service_role', 'payroll_cut_save(date, date, jsonb, uuid)', 'EXECUTE'), 'service_role must execute save';
  assert has_function_privilege('service_role', 'payroll_cut_void(bigint, text, uuid)', 'EXECUTE'), 'service_role must execute void';

  -- 9. RLS on for the four tables, no policies, no table privileges for anon/authenticated.
  foreach t in array array['payroll_cuts','payroll_cut_lines','payroll_cut_weeks','payroll_cut_history'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), 'RLS must be on for ' || t;
    assert not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t), 'no policies on ' || t;
    assert not has_table_privilege('anon', 'public.' || t, 'SELECT'), 'anon must not read ' || t;
    assert not has_table_privilege('authenticated', 'public.' || t, 'SELECT'), 'authenticated must not read ' || t;
  end loop;

  raise notice 'ALL CHECKS PASSED';
end
$$;

rollback;
