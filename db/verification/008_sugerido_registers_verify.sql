-- 008_sugerido_registers_verify.sql: manual verification of the registers_override migration.
-- Run in the Supabase SQL editor AFTER 008_sugerido_registers.sql. NEVER run it as part of tests.
-- It runs everything inside ONE transaction and ends with ROLLBACK, so nothing is kept. Expected failures are
-- caught in nested BEGIN/EXCEPTION blocks (each one is a savepoint). A failed check raises and stops the script;
-- a final "ALL CHECKS PASSED" notice means every check held.
--
-- Note: the SQL editor may run the whole script in one batch. If your editor auto-commits each statement,
-- run it from a psql session instead (begin/rollback are explicit below).

begin;

do $$
begin
  -- 1. Structure: nullable int column, RLS on, closed to anon/authenticated.
  assert (select data_type = 'integer' and is_nullable = 'YES' from information_schema.columns
           where table_schema = 'public' and table_name = 'sugerido_sedes' and column_name = 'registers_override'),
    'registers_override is a nullable integer';
  assert exists (select 1 from pg_constraint
                  where conrelid = 'sugerido_sedes'::regclass and conname = 'sugerido_sedes_registers_override_chk'),
    'the range constraint exists';
  assert (select relrowsecurity from pg_class where oid = 'sugerido_sedes'::regclass), 'RLS stays enabled';
  assert not has_table_privilege('anon', 'sugerido_sedes', 'select') and not has_table_privilege('authenticated', 'sugerido_sedes', 'select'),
    'anon/authenticated have no privileges on sugerido_sedes';

  -- 2. Range 1..50 or NULL.
  insert into sugerido_sedes (sede_id, nombre, bodegas) values ('zz-verify-008', 'Verify 008', array['ZZ008']);
  update sugerido_sedes set registers_override = 1 where sede_id = 'zz-verify-008';
  update sugerido_sedes set registers_override = 50 where sede_id = 'zz-verify-008';
  update sugerido_sedes set registers_override = null where sede_id = 'zz-verify-008';

  begin
    update sugerido_sedes set registers_override = 0 where sede_id = 'zz-verify-008';
    raise exception 'registers_override = 0 must be rejected';
  exception when check_violation then null;
  end;
  begin
    update sugerido_sedes set registers_override = 51 where sede_id = 'zz-verify-008';
    raise exception 'registers_override = 51 must be rejected';
  exception when check_violation then null;
  end;
  begin
    update sugerido_sedes set registers_override = -3 where sede_id = 'zz-verify-008';
    raise exception 'a negative registers_override must be rejected';
  exception when check_violation then null;
  end;

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
