-- Rollback of 014_overtime_requests.sql. Redeploy the backend that predates 014 first. Idempotent.
-- Copies the table into overtime_requests_backup_014 first (kept if it already exists, so a re-run never overwrites the
-- first copy); drop that table by hand once the rollback is confirmed.

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'overtime_requests')
     and not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'overtime_requests_backup_014') then
    execute 'create table overtime_requests_backup_014 as select * from overtime_requests';
    execute 'alter table overtime_requests_backup_014 enable row level security'; -- no policies: service role only
    execute 'revoke all on table overtime_requests_backup_014 from anon, authenticated';
  end if;
end $$;

drop table if exists overtime_requests;
