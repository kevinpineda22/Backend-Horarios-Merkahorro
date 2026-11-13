-- Rollback of 011_cashier_exclusions.sql. Drops the table: every exclusion (active and revoked) is lost, so every
-- employee counts as a cashier again. Redeploy the backend that predates 011 first (the new one reads this table).
-- Idempotent. Copies the table into cashier_exclusions_backup_011 first (kept if it already exists, so a re-run never
-- overwrites the first snapshot); drop that table by hand once the rollback is confirmed.

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'cashier_exclusions')
     and not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'cashier_exclusions_backup_011') then
    execute 'create table cashier_exclusions_backup_011 as select * from cashier_exclusions';
    execute 'alter table cashier_exclusions_backup_011 enable row level security'; -- no policies: service role only
    execute 'revoke all on table cashier_exclusions_backup_011 from anon, authenticated';
  end if;
end $$;

drop table if exists cashier_exclusions;
