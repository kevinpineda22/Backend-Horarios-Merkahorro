-- Rollback of 015_schedule_teams.sql. Redeploy the backend that predates 015 right after running it. The old RPC
-- signatures exist after 015 only as wrappers over the new p_team functions, so this script drops BOTH sets and the
-- real pre-team bodies are restored by re-running 004, 010 and 014 (last step: MANDATORY, not optional).
--
-- It REFUSES to run while any schedule belongs to a team other than CAJEROS: going back to one document per sede-week
-- would either violate UNIQUE (sede_id, week_start) or silently relabel those schedules as cashiers. Delete or move them
-- by hand first. Idempotent.

do $$
begin
  if exists (select 1 from sede_week_schedules where team_key <> 'CAJEROS') then
    raise exception 'ROLLBACK_REFUSED: schedules of other teams exist (team_key <> CAJEROS); remove them first';
  end if;
end $$;

drop function if exists shifts_save_week(text, date, text, int, text[], jsonb, uuid, jsonb);
drop function if exists shifts_save_week(text, date, text, int, text[], jsonb, uuid);
drop function if exists shifts_publish_week(text, date, text, int, uuid, jsonb);
drop function if exists shifts_publish_week(text, date, text, int, uuid);
drop function if exists shifts_unpublish_week(text, date, text, int, uuid);
-- The 015 wrappers (old signatures) would call the functions dropped above: drop them too, then restore them below.
drop function if exists shifts_save_week(text, date, int, text[], jsonb, uuid, jsonb);
drop function if exists shifts_save_week(text, date, int, text[], jsonb, uuid);
drop function if exists shifts_publish_week(text, date, int, uuid, jsonb);
drop function if exists shifts_publish_week(text, date, int, uuid);
drop function if exists shifts_unpublish_week(text, date, int, uuid);

drop index if exists schedule_publish_snapshots_week_idx;
create index if not exists schedule_publish_snapshots_week_idx on schedule_publish_snapshots (sede_id, week_start, published_at desc);
alter table schedule_publish_snapshots drop column if exists team_key;

alter table sede_week_schedules drop constraint if exists sws_sede_week_team_key;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'sede_week_schedules'::regclass and contype = 'u'
       and pg_get_constraintdef(oid) = 'UNIQUE (sede_id, week_start)') then
    alter table sede_week_schedules add constraint sede_week_schedules_sede_id_week_start_key unique (sede_id, week_start);
  end if;
end $$;
alter table sede_week_schedules drop constraint if exists sws_team_key_chk;
alter table sede_week_schedules drop column if exists team_key;

-- Last step, by hand in the SQL editor and MANDATORY: re-run 004_shifts.sql, 010_unpublish_schedule.sql and
-- 014_shift_segments.sql (all idempotent, in that order) to recreate the real pre-team shifts_save_week /
-- shifts_publish_week / shifts_unpublish_week with their original bodies. Until then no RPC with those names exists.
