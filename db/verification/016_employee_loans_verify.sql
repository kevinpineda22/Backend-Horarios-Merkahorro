-- 016_employee_loans_verify.sql: manual verification. Run in the Supabase SQL editor AFTER 016. NEVER in tests.
-- One transaction that ends with ROLLBACK (it only touches far-fetched cedulas and two existing sedes); expected failures
-- are caught in nested BEGIN/EXCEPTION blocks. A final "ALL CHECKS PASSED" notice means every check held.

begin;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
  v_home text;
  v_host text;
begin
  select min(sede_id), max(sede_id) into v_home, v_host from sugerido_sedes;
  assert v_home is not null and v_home <> v_host, 'needs at least two rows in sugerido_sedes';

  insert into employee_loans (cedula, home_sede_id, host_sede_id, week_start, motivo, created_by)
  values ('99999991', v_home, v_host, '2031-01-06', 'Apoyo', v_actor);

  -- Only Mondays.
  begin
    insert into employee_loans (cedula, home_sede_id, host_sede_id, week_start, created_by) values ('99999992', v_home, v_host, '2031-01-07', v_actor);
    raise exception 'a non-Monday week_start must be rejected';
  exception when check_violation then null;
  end;

  -- Home and host differ.
  begin
    insert into employee_loans (cedula, home_sede_id, host_sede_id, week_start, created_by) values ('99999993', v_home, v_home, '2031-01-06', v_actor);
    raise exception 'home = host must be rejected';
  exception when check_violation then null;
  end;

  -- Malformed cedula and long motivo.
  begin
    insert into employee_loans (cedula, home_sede_id, host_sede_id, week_start, created_by) values ('12', v_home, v_host, '2031-01-06', v_actor);
    raise exception 'a malformed cedula must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into employee_loans (cedula, home_sede_id, host_sede_id, week_start, motivo, created_by) values ('99999994', v_home, v_host, '2031-01-06', repeat('x', 201), v_actor);
    raise exception 'a motivo over 200 characters must be rejected';
  exception when check_violation then null;
  end;

  -- Unknown sedes are rejected by the foreign keys.
  begin
    insert into employee_loans (cedula, home_sede_id, host_sede_id, week_start, created_by) values ('99999995', v_home, 'no-such-sede', '2031-01-06', v_actor);
    raise exception 'an unknown host sede must be rejected';
  exception when foreign_key_violation then null;
  end;

  -- One ACTIVE loan per (cedula, week).
  begin
    insert into employee_loans (cedula, home_sede_id, host_sede_id, week_start, created_by) values ('99999991', v_home, v_host, '2031-01-06', v_actor);
    raise exception 'a second active loan for the same week must be rejected';
  exception when unique_violation then null;
  end;

  -- The revoke pair travels together.
  begin
    update employee_loans set revoked_at = now() where cedula = '99999991';
    raise exception 'revoked_at without revoked_by must be rejected';
  exception when check_violation then null;
  end;

  -- After a soft revoke the week is free again and the history keeps both rows.
  update employee_loans set revoked_at = now(), revoked_by = v_actor where cedula = '99999991' and revoked_at is null;
  insert into employee_loans (cedula, home_sede_id, host_sede_id, week_start, created_by) values ('99999991', v_home, v_host, '2031-01-06', v_actor);
  assert (select count(*) from employee_loans where cedula = '99999991') = 2, 'history keeps both rows';

  -- Another week of the same person is independent.
  insert into employee_loans (cedula, home_sede_id, host_sede_id, week_start, created_by) values ('99999991', v_home, v_host, '2031-01-13', v_actor);

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
