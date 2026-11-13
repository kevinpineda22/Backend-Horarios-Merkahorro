-- 012_cashier_inclusions_verify.sql: manual verification. Run in the Supabase SQL editor AFTER 012. NEVER in tests.
-- One transaction that ends with ROLLBACK (it only touches far-fetched cedulas); expected failures are caught in nested
-- BEGIN/EXCEPTION blocks. A final "ALL CHECKS PASSED" notice means every check held.

begin;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
begin
  -- Existing rows and rows written without a kind are exclusions.
  assert not exists (select 1 from cashier_exclusions where kind is null), 'every row has a kind';
  insert into cashier_exclusions (cedula, created_by) values ('99999981', v_actor);
  assert (select kind from cashier_exclusions where cedula = '99999981') = 'exclude', 'default kind is exclude';

  insert into cashier_exclusions (cedula, sede_id, motivo, created_by, kind) values ('99999982', 'copacabana', 'Cajera PAC', v_actor, 'include');

  -- Only the two kinds.
  begin
    insert into cashier_exclusions (cedula, created_by, kind) values ('99999983', v_actor, 'otro');
    raise exception 'an unknown kind must be rejected';
  exception when check_violation then null;
  end;

  -- Still one ACTIVE mark per cedula, whatever its kind.
  begin
    insert into cashier_exclusions (cedula, created_by, kind) values ('99999982', v_actor, 'exclude');
    raise exception 'a second active mark must be rejected';
  exception when unique_violation then null;
  end;

  -- Switching marks = revoke one, insert the other; history keeps both.
  update cashier_exclusions set revoked_at = now(), revoked_by = v_actor where cedula = '99999982' and revoked_at is null;
  insert into cashier_exclusions (cedula, created_by, kind) values ('99999982', v_actor, 'exclude');
  assert (select count(*) from cashier_exclusions where cedula = '99999982') = 2, 'history keeps both rows';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
