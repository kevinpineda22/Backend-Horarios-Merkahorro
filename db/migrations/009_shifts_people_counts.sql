-- 009_shifts_people_counts.sql: grouped head-count for the schedules list ("Horarios publicados").
-- Apply manually in the Supabase SQL editor (any time after 004), then run db/verification/009_shifts_people_counts_verify.sql.
-- Idempotent. Adds one read-only function; no table changes.
--
-- shifts_people_counts(p_schedule_ids) returns one row per schedule that has shifts: the number of DISTINCT cedulas
-- with at least one row (any tipo, DESCANSO included) in that schedule. PostgREST cannot GROUP BY, so this keeps the
-- list at two round trips instead of one query per week.
--
-- DEPLOY: apply this BEFORE deploying the backend (GET /horarios/sedes/:sedeId/schedules calls it).
-- ROLLBACK: db/migrations/rollback/009_shifts_people_counts.down.sql

create or replace function shifts_people_counts(p_schedule_ids uuid[])
returns table (schedule_id uuid, people int)
language sql
stable
security invoker
as $$
  select s.schedule_id, count(distinct s.cedula)::int
    from shifts s
   where s.schedule_id = any (p_schedule_ids)
   group by s.schedule_id;
$$;

-- Executable by service_role only (Supabase grants EXECUTE on new functions to anon/authenticated).
revoke all on function shifts_people_counts(uuid[]) from public;
revoke all on function shifts_people_counts(uuid[]) from anon, authenticated;
grant execute on function shifts_people_counts(uuid[]) to service_role;
