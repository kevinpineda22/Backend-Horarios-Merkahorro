-- Rollback of 016_employee_loans.sql. Drops the table: every loan (active and cancelled) is lost, so every person goes
-- back to her home sede. Redeploy the backend that predates 016 first (the new one reads this table).
-- Copies the table into employee_loans_backup_016 first. If that backup already exists the script STOPS without dropping
-- anything (a re-run must never overwrite or silently skip the first snapshot): rename or drop the old backup by hand first.

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'employee_loans') then
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'employee_loans_backup_016') then
      raise exception 'employee_loans_backup_016 already exists: rename it (alter table employee_loans_backup_016 rename to ...) or drop it, then run this rollback again';
    end if;
    execute 'create table employee_loans_backup_016 as select * from employee_loans';
    execute 'alter table employee_loans_backup_016 enable row level security'; -- no policies: service role only
    execute 'revoke all on table employee_loans_backup_016 from anon, authenticated';
    execute 'drop table employee_loans'; -- inside the block: the exception above can never be followed by the drop
  end if;
end $$;
