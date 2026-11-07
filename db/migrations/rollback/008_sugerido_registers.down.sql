-- Rollback of 008_sugerido_registers.sql. Destroys every registers_override value.
-- Redeploy the backend that predates 008 FIRST (the new one selects this column and fails without it).
-- Idempotent. Copies the overrides into sugerido_sedes_registers_backup_008 first (kept if it already exists, so a
-- re-run never overwrites the first snapshot); drop that table by hand once the rollback is confirmed.

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'sugerido_sedes' and column_name = 'registers_override')
     and not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'sugerido_sedes_registers_backup_008') then
    execute 'create table sugerido_sedes_registers_backup_008 as
             select sede_id, registers_override from sugerido_sedes where registers_override is not null';
    execute 'alter table sugerido_sedes_registers_backup_008 enable row level security'; -- no policies: service role only
    execute 'revoke all on table sugerido_sedes_registers_backup_008 from anon, authenticated';
  end if;
end $$;

alter table sugerido_sedes drop constraint if exists sugerido_sedes_registers_override_chk;
alter table sugerido_sedes drop column if exists registers_override;
