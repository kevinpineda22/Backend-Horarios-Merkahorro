-- 011_cashier_exclusions_verify.sql: manual verification. Run in the Supabase SQL editor AFTER 011. NEVER in tests.
-- One transaction that ends with ROLLBACK (it only touches a far-fetched cedula); expected failures are caught in nested
-- BEGIN/EXCEPTION blocks. A final "ALL CHECKS PASSED" notice means every check held.

begin;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
begin
  assert (select relrowsecurity from pg_class where oid = 'cashier_exclusions'::regclass), 'RLS enabled';
  assert not has_table_privilege('anon', 'cashier_exclusions', 'select') and not has_table_privilege('authenticated', 'cashier_exclusions', 'select'),
    'anon/authenticated have no privileges';

  insert into cashier_exclusions (cedula, sede_id, motivo, created_by) values ('99999991', 'copacabana', 'Solo surtidor', v_actor);

  -- Only one ACTIVE row per cedula.
  begin
    insert into cashier_exclusions (cedula, created_by) values ('99999991', v_actor);
    raise exception 'a second active row must be rejected';
  exception when unique_violation then null;
  end;

  -- Validation: cedula shape, motivo length, revoke columns travel together.
  begin
    insert into cashier_exclusions (cedula, created_by) values ('abc', v_actor);
    raise exception 'a bad cedula must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into cashier_exclusions (cedula, motivo, created_by) values ('99999992', repeat('x', 201), v_actor);
    raise exception 'a motivo over 200 characters must be rejected';
  exception when check_violation then null;
  end;
  begin
    update cashier_exclusions set revoked_at = now() where cedula = '99999991';
    raise exception 'revoked_at without revoked_by must be rejected';
  exception when check_violation then null;
  end;

  -- After a soft revoke the cedula can be excluded again; history keeps both rows.
  update cashier_exclusions set revoked_at = now(), revoked_by = v_actor where cedula = '99999991';
  insert into cashier_exclusions (cedula, sede_id, created_by) values ('99999991', 'copacabana', v_actor);
  assert (select count(*) from cashier_exclusions where cedula = '99999991') = 2, 'history keeps both rows';
  assert (select count(*) from cashier_exclusions where cedula = '99999991' and revoked_at is null) = 1, 'one active row';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
