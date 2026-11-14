-- 014_shift_segments.sql: the caja/surtido split of each worked shift, frozen when the leader publishes, so the public
-- "mi horario" page can tell employees where they work during the day.
-- Apply manually in the Supabase SQL editor (after 004 and 010), then run db/verification/014_shift_segments_verify.sql.
-- Idempotent. Only the backend (service role) touches these objects.
--
-- What changes:
--   * shifts.segments jsonb NULL: null (not frozen: drafts, weeks published before 014) or a JSON array of
--     { "role": "caja"|"surtido", "from": "HH:MM", "to": "HH:MM" }, ordered, on the 15-minute grid, inside the shift.
--     The API validates the content; the CHECK only guarantees "array, and only on TRABAJO rows".
--   * shifts_publish_week(text, date, int, uuid, jsonb): publish + write the segments in the SAME transaction. It calls the
--     4-argument function (unchanged, still callable) and then stores p_segments = [{ cedula, fecha, segments }] for the
--     week's TRABAJO shifts; shifts not listed get null. An already published week is a no-op (segments untouched).
--   * shifts_save_week(text, date, int, text[], jsonb, uuid, jsonb): save + refresh the segments of the SENT cedulas
--     when the week is PUBLICADO (same transaction). On a draft the segments argument is ignored (they are set at publish).
--   * shifts_apply_segments(uuid, text[], jsonb): internal helper of the two functions above.
--   * Trigger on shifts: when a row changes its tipo / times / break / lunch and the same UPDATE does not bring new
--     segments, segments are reset to null, so a stale split can never survive an edit (works with the old save function).
--   * Trigger on sede_week_schedules: PUBLICADO -> BORRADOR (unpublish) clears the week's segments.
--
-- DEPLOY: apply this BEFORE deploying the backend. The backend also survives the opposite order: when the new functions
-- or the column do not exist yet it falls back to the old publish/save and the public endpoint answers segmentos: null
-- (a warning is logged), but weeks published in that window have no split.
-- ROLLBACK: db/migrations/rollback/014_shift_segments.down.sql (keeps a copy of the segments, then drops everything).

alter table shifts add column if not exists segments jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shifts_segments_chk' and conrelid = 'shifts'::regclass) then
    alter table shifts add constraint shifts_segments_chk
      check (segments is null or (jsonb_typeof(segments) = 'array' and tipo = 'TRABAJO'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Stale segments never survive an edit.
-- ---------------------------------------------------------------------------
create or replace function shifts_reset_stale_segments()
returns trigger
language plpgsql
as $$
begin
  if new.segments is not distinct from old.segments
     and (new.tipo, new.start_time, new.end_time, new.break_minutes, new.lunch_start)
         is distinct from (old.tipo, old.start_time, old.end_time, old.break_minutes, old.lunch_start) then
    new.segments := null;
  end if;
  return new;
end
$$;

drop trigger if exists shifts_reset_stale_segments_trg on shifts;
create trigger shifts_reset_stale_segments_trg
  before update on shifts
  for each row execute function shifts_reset_stale_segments();

create or replace function shifts_clear_segments_on_unpublish()
returns trigger
language plpgsql
as $$
begin
  if old.state = 'PUBLICADO' and new.state = 'BORRADOR' then
    update shifts set segments = null where schedule_id = new.id and segments is not null;
  end if;
  return new;
end
$$;

drop trigger if exists shifts_clear_segments_on_unpublish_trg on sede_week_schedules;
create trigger shifts_clear_segments_on_unpublish_trg
  after update of state on sede_week_schedules
  for each row execute function shifts_clear_segments_on_unpublish();

-- ---------------------------------------------------------------------------
-- Helper: set the segments of a schedule's TRABAJO shifts from [{ cedula, fecha, segments }].
-- p_cedulas null = every shift of the schedule. Shifts without an entry (or with an empty list) get null.
-- ---------------------------------------------------------------------------
create or replace function shifts_apply_segments(p_schedule uuid, p_cedulas text[], p_segments jsonb)
returns void
language plpgsql
security invoker
as $$
declare
  v_items jsonb := case when jsonb_typeof(p_segments) = 'array' then p_segments else '[]'::jsonb end;
begin
  update shifts s
     set segments = case when s.tipo = 'TRABAJO' then (
           select i.segments
             from jsonb_to_recordset(v_items) as i(cedula text, fecha date, segments jsonb)
            where i.cedula = s.cedula and i.fecha = s.fecha
              and jsonb_typeof(i.segments) = 'array' and jsonb_array_length(i.segments) > 0
            limit 1) end
   where s.schedule_id = p_schedule
     and (p_cedulas is null or s.cedula = any(p_cedulas));
end
$$;

-- ---------------------------------------------------------------------------
-- Publish + segments, atomically.
-- ---------------------------------------------------------------------------
create or replace function shifts_publish_week(
  p_sede text, p_week date, p_expected_version int, p_actor uuid, p_segments jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_result jsonb;
begin
  v_result := shifts_publish_week(p_sede, p_week, p_expected_version, p_actor);
  if not coalesce((v_result ->> 'noop')::boolean, false) then
    perform shifts_apply_segments((v_result ->> 'id')::uuid, null, p_segments);
  end if;
  return v_result;
end
$$;

-- ---------------------------------------------------------------------------
-- Save + segments, atomically (segments only matter when the week is already PUBLICADO).
-- ---------------------------------------------------------------------------
create or replace function shifts_save_week(
  p_sede text, p_week date, p_expected_version int, p_cedulas text[], p_shifts jsonb, p_actor uuid, p_segments jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_result jsonb;
begin
  v_result := shifts_save_week(p_sede, p_week, p_expected_version, p_cedulas, p_shifts, p_actor);
  if v_result ->> 'state' = 'PUBLICADO' then
    perform shifts_apply_segments((v_result ->> 'id')::uuid, p_cedulas, p_segments);
  end if;
  return v_result;
end
$$;

-- Executable by service_role only (Supabase grants EXECUTE on new functions to anon/authenticated).
revoke all on function shifts_apply_segments(uuid, text[], jsonb) from public;
revoke all on function shifts_publish_week(text, date, int, uuid, jsonb) from public;
revoke all on function shifts_save_week(text, date, int, text[], jsonb, uuid, jsonb) from public;
revoke all on function shifts_apply_segments(uuid, text[], jsonb) from anon, authenticated;
revoke all on function shifts_publish_week(text, date, int, uuid, jsonb) from anon, authenticated;
revoke all on function shifts_save_week(text, date, int, text[], jsonb, uuid, jsonb) from anon, authenticated;
grant execute on function shifts_apply_segments(uuid, text[], jsonb) to service_role;
grant execute on function shifts_publish_week(text, date, int, uuid, jsonb) to service_role;
grant execute on function shifts_save_week(text, date, int, text[], jsonb, uuid, jsonb) to service_role;
