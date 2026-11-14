-- Rollback of 014_shift_segments.sql. Redeploy the backend that predates 014 first (or not: the new one falls back to the
-- old publish/save when the functions are missing). Idempotent. Copies the frozen segments into
-- shifts_segments_backup_014 first (kept if it already exists, so a re-run never overwrites the first copy); drop that
-- table by hand once the rollback is confirmed.

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'shifts' and column_name = 'segments')
     and not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'shifts_segments_backup_014') then
    execute 'create table shifts_segments_backup_014 as select id, schedule_id, cedula, fecha, segments from shifts where segments is not null';
    execute 'alter table shifts_segments_backup_014 enable row level security'; -- no policies: service role only
    execute 'revoke all on table shifts_segments_backup_014 from anon, authenticated';
  end if;
end $$;

drop trigger if exists shifts_clear_segments_on_unpublish_trg on sede_week_schedules;
drop trigger if exists shifts_reset_stale_segments_trg on shifts;
drop function if exists shifts_clear_segments_on_unpublish();
drop function if exists shifts_reset_stale_segments();
drop function if exists shifts_save_week(text, date, int, text[], jsonb, uuid, jsonb);
drop function if exists shifts_publish_week(text, date, int, uuid, jsonb);
drop function if exists shifts_apply_segments(uuid, text[], jsonb);
alter table shifts drop constraint if exists shifts_segments_chk;
alter table shifts drop column if exists segments;
