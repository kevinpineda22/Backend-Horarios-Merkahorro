-- Rollback of 013_publish_snapshots.sql. Redeploy the backend that predates 013 first (or not: the new one only logs
-- when the table is missing). Idempotent. Copies the table into schedule_publish_snapshots_backup_013 first (kept if it
-- already exists, so a re-run never overwrites the first copy); drop that table by hand once the rollback is confirmed.

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'schedule_publish_snapshots')
     and not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'schedule_publish_snapshots_backup_013') then
    execute 'create table schedule_publish_snapshots_backup_013 as select * from schedule_publish_snapshots';
    execute 'alter table schedule_publish_snapshots_backup_013 enable row level security'; -- no policies: service role only
    execute 'revoke all on table schedule_publish_snapshots_backup_013 from anon, authenticated';
  end if;
end $$;

drop table if exists schedule_publish_snapshots;
