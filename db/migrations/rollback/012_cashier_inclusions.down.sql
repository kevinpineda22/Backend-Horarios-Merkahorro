-- Rollback of 012_cashier_inclusions.sql. Redeploy the backend that predates 012 first (the new one selects `kind`).
-- Idempotent. Copies the include rows into cashier_inclusions_backup_012 first (kept if it already exists, so a re-run
-- never overwrites the first snapshot), then DELETES them: without `kind` they would read as exclusions and take those
-- people out of the cashier pool. Drop the backup table by hand once the rollback is confirmed.

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cashier_exclusions' and column_name = 'kind') then
    if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'cashier_inclusions_backup_012') then
      execute 'create table cashier_inclusions_backup_012 as select * from cashier_exclusions where kind = ''include''';
      execute 'alter table cashier_inclusions_backup_012 enable row level security'; -- no policies: service role only
      execute 'revoke all on table cashier_inclusions_backup_012 from anon, authenticated';
    end if;
    execute 'delete from cashier_exclusions where kind = ''include''';
  end if;
end $$;

alter table cashier_exclusions drop constraint if exists cashier_exclusions_kind_chk;
alter table cashier_exclusions drop column if exists kind;
