-- 014_overtime_requests_verify.sql: manual verification. Run in the Supabase SQL editor AFTER 014. NEVER in tests.
-- One transaction that ends with ROLLBACK. A final "ALL CHECKS PASSED" notice means every check held.

begin;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
begin
  assert (select relrowsecurity from pg_class where oid = 'overtime_requests'::regclass), 'RLS enabled';
  assert not has_table_privilege('anon', 'overtime_requests', 'select')
     and not has_table_privilege('authenticated', 'overtime_requests', 'select'), 'anon/authenticated have no privileges';

  insert into overtime_requests (sede_id, week_start, hours, motivo, requested_by) values ('zz-test', '2031-01-06', 6.5, 'Prueba', v_actor);

  -- One pending request per sede-week.
  begin
    insert into overtime_requests (sede_id, week_start, hours, motivo, requested_by) values ('zz-test', '2031-01-06', 2, 'Otra', v_actor);
    raise exception 'a second pending request must be rejected';
  exception when unique_violation then null;
  end;

  -- Monday only, hours in (0, 100], a reason.
  begin
    insert into overtime_requests (sede_id, week_start, hours, motivo, requested_by) values ('zz-test', '2031-01-07', 2, 'x', v_actor);
    raise exception 'a non-Monday week must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into overtime_requests (sede_id, week_start, hours, motivo, requested_by) values ('zz-test', '2031-01-13', 0, 'x', v_actor);
    raise exception 'zero hours must be rejected';
  exception when check_violation then null;
  end;

  -- A decision needs who and when.
  begin
    update overtime_requests set status = 'APROBADA' where sede_id = 'zz-test';
    raise exception 'a decision without decided_by must be rejected';
  exception when check_violation then null;
  end;
  update overtime_requests set status = 'APROBADA', decided_by = v_actor, decided_at = now() where sede_id = 'zz-test';

  -- Once decided, a new request for the same week is allowed.
  insert into overtime_requests (sede_id, week_start, hours, motivo, requested_by) values ('zz-test', '2031-01-06', 2, 'Otra', v_actor);
  assert (select count(*) from overtime_requests where sede_id = 'zz-test') = 2, 'history keeps both';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
