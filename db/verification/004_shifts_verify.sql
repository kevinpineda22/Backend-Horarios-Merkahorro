-- 004_shifts_verify.sql: manual verification of the shift RPCs.
-- Run in the Supabase SQL editor AFTER 004_shifts.sql and the seed. NEVER run it as part of tests.
-- It works in a far-future week (2031-01-06, a Monday), runs everything inside ONE transaction
-- and ends with ROLLBACK, so nothing is kept. Each block raises on failure; a final
-- "ALL CHECKS PASSED" notice means every check held. Needs sedes copacabana and las-vegas.
--
-- Note: the SQL editor may run the whole script in one batch. If your editor auto-commits each
-- statement, run it from a psql session instead (begin/rollback are explicit below).

begin;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
  v_week  date := date '2031-01-06';
  v_res jsonb;
  v_sched uuid;
  v_n int;
  v_ids_before uuid[];
  v_ids_after uuid[];
  v_state text;
begin
  -- 1. First save: creates the schedule, expected version 0 -> version 1, history CREAR x2.
  v_res := shifts_save_week('copacabana', v_week, 0, array['11111111'], jsonb_build_array(
    jsonb_build_object('cedula','11111111','fecha','2031-01-06','tipo','TRABAJO','start_time','08:00','end_time','17:00','break_minutes',60),
    jsonb_build_object('cedula','11111111','fecha','2031-01-07','tipo','DESCANSO')), v_actor);
  assert (v_res->>'version')::int = 1, 'first save must return version 1';
  v_sched := (v_res->>'id')::uuid;
  select count(*) into v_n from shift_history where schedule_id = v_sched and action = 'CREAR' and schedule_version = 1;
  assert v_n = 2, 'two CREAR history rows expected, got ' || v_n;
  select count(*) into v_n from shifts where schedule_id = v_sched and siesa_code = '001';
  assert v_n = 2, 'siesa_code snapshot must be 001 on both rows';

  -- 2. Version check: a stale expected version raises VERSION_CONFLICT with the current version.
  begin
    perform shifts_save_week('copacabana', v_week, 0, array['11111111'], '[]'::jsonb, v_actor);
    raise exception 'expected VERSION_CONFLICT';
  exception when others then
    assert sqlerrm = 'VERSION_CONFLICT', 'stale save must raise VERSION_CONFLICT, got ' || sqlerrm;
  end;
  -- Missing schedule + expected > 0 -> VERSION_CONFLICT too.
  begin
    perform shifts_save_week('copacabana', date '2031-01-13', 3, array['11111111'], '[]'::jsonb, v_actor);
    raise exception 'expected VERSION_CONFLICT';
  exception when others then
    assert sqlerrm = 'VERSION_CONFLICT', 'missing schedule with expected>0 must raise VERSION_CONFLICT';
  end;

  -- 3. Unchanged rows: same ids, no new history rows (only the version moves).
  select array_agg(id order by fecha) into v_ids_before from shifts where schedule_id = v_sched;
  select count(*) into v_n from shift_history where schedule_id = v_sched;
  v_res := shifts_save_week('copacabana', v_week, 1, array['11111111'], jsonb_build_array(
    jsonb_build_object('cedula','11111111','fecha','2031-01-06','tipo','TRABAJO','start_time','08:00','end_time','17:00','break_minutes',60),
    jsonb_build_object('cedula','11111111','fecha','2031-01-07','tipo','DESCANSO')), v_actor);
  assert (v_res->>'version')::int = 2, 'no-diff save still bumps the version';
  select array_agg(id order by fecha) into v_ids_after from shifts where schedule_id = v_sched;
  assert v_ids_before = v_ids_after, 'row ids must be stable for unchanged rows';
  assert (select count(*) from shift_history where schedule_id = v_sched) = v_n, 'unchanged rows must write no history';

  -- 4. Edit + delete write EDITAR / ELIMINAR; other cedulas are never deleted.
  perform shifts_save_week('copacabana', v_week, 2, array['22222222'], jsonb_build_array(
    jsonb_build_object('cedula','22222222','fecha','2031-01-06','tipo','TRABAJO','start_time','06:00','end_time','14:00','break_minutes',60)), v_actor);
  assert (select count(*) from shifts where schedule_id = v_sched and cedula = '11111111') = 2, 'rows of unsent cedulas must remain';
  perform shifts_save_week('copacabana', v_week, 3, array['11111111'], jsonb_build_array(
    jsonb_build_object('cedula','11111111','fecha','2031-01-06','tipo','TRABAJO','start_time','09:00','end_time','17:00','break_minutes',60)), v_actor);
  assert (select count(*) from shift_history where schedule_id = v_sched and action = 'EDITAR' and before is not null and after is not null) = 1, 'one EDITAR row expected';
  assert (select count(*) from shift_history where schedule_id = v_sched and action = 'ELIMINAR' and after is null) = 1, 'one ELIMINAR row expected';

  -- 5. Failed saves roll back rows AND history: duplicate key, then an overlap inside the payload
  --    (22:00-06:00 on Jan 8 crossing into 05:00-09:00 on Jan 9, same cedula).
  select count(*) into v_n from shift_history where schedule_id = v_sched;
  begin
    perform shifts_save_week('copacabana', v_week, 4, array['33333333'], jsonb_build_array(
      jsonb_build_object('cedula','33333333','fecha','2031-01-08','tipo','TRABAJO','start_time','08:00','end_time','12:00','break_minutes',0),
      jsonb_build_object('cedula','33333333','fecha','2031-01-08','tipo','TRABAJO','start_time','13:00','end_time','15:00','break_minutes',0)), v_actor);
    raise exception 'expected INVALID_SHIFTS';
  exception when others then
    assert sqlerrm = 'INVALID_SHIFTS', 'duplicate key must raise INVALID_SHIFTS, got ' || sqlerrm;
  end;
  begin
    perform shifts_save_week('copacabana', v_week, 4, array['33333333'], jsonb_build_array(
      jsonb_build_object('cedula','33333333','fecha','2031-01-08','tipo','TRABAJO','start_time','22:00','end_time','06:00','break_minutes',0),
      jsonb_build_object('cedula','33333333','fecha','2031-01-09','tipo','TRABAJO','start_time','05:00','end_time','09:00','break_minutes',0)), v_actor);
    raise exception 'expected SHIFT_OVERLAP';
  exception when others then
    assert sqlerrm = 'SHIFT_OVERLAP', 'payload overlap must raise SHIFT_OVERLAP, got ' || sqlerrm;
  end;
  assert (select count(*) from shift_history where schedule_id = v_sched) = v_n, 'failed saves must write no history';
  assert (select count(*) from shifts where cedula = '33333333') = 0, 'failed saves must leave no rows';
  assert (select version from sede_week_schedules where id = v_sched) = 4, 'failed saves must not move the version';

  -- 6. Midnight crossing: 22:00-06:00 on Jan 8 (cedula 44444444), then 05:00-09:00 on Jan 9 overlaps (rejected);
  --    06:00-10:00 on Jan 9 only touches (accepted).
  perform shifts_save_week('copacabana', v_week, 4, array['44444444'], jsonb_build_array(
    jsonb_build_object('cedula','44444444','fecha','2031-01-08','tipo','TRABAJO','start_time','22:00','end_time','06:00','break_minutes',0)), v_actor);
  begin
    perform shifts_save_week('las-vegas', v_week, 0, array['44444444'], jsonb_build_array(
      jsonb_build_object('cedula','44444444','fecha','2031-01-09','tipo','TRABAJO','start_time','05:00','end_time','09:00','break_minutes',0)), v_actor);
    raise exception 'expected SHIFT_OVERLAP';
  exception when others then
    assert sqlerrm = 'SHIFT_OVERLAP', 'crossing overlap (cross-sede) must raise SHIFT_OVERLAP, got ' || sqlerrm;
  end;
  assert not exists (select 1 from sede_week_schedules where sede_id = 'las-vegas' and week_start = v_week),
    'overlap failure must roll back the new las-vegas schedule';
  perform shifts_save_week('las-vegas', v_week, 0, array['44444444'], jsonb_build_array(
    jsonb_build_object('cedula','44444444','fecha','2031-01-09','tipo','TRABAJO','start_time','06:00','end_time','10:00','break_minutes',0)), v_actor);

  -- 7. +-1 day window across weeks: a row on Sunday 2031-01-05 (previous week) 23:00-07:00 vs Monday 06:00-08:00.
  perform shifts_save_week('copacabana', date '2030-12-30', 0, array['55555555'], jsonb_build_array(
    jsonb_build_object('cedula','55555555','fecha','2031-01-05','tipo','TRABAJO','start_time','23:00','end_time','07:00','break_minutes',0)), v_actor);
  begin
    perform shifts_save_week('las-vegas', v_week, 1, array['55555555'], jsonb_build_array(
      jsonb_build_object('cedula','55555555','fecha','2031-01-06','tipo','TRABAJO','start_time','06:00','end_time','08:00','break_minutes',0)), v_actor);
    raise exception 'expected SHIFT_OVERLAP';
  exception when others then
    assert sqlerrm = 'SHIFT_OVERLAP', 'previous-week crossing must raise SHIFT_OVERLAP, got ' || sqlerrm;
  end;

  -- 8. Publish: needs the right version, writes one PUBLICAR row, a second publish is a no-op.
  begin
    perform shifts_publish_week('copacabana', v_week, 1, v_actor);
    raise exception 'expected VERSION_CONFLICT';
  exception when others then
    assert sqlerrm = 'VERSION_CONFLICT', 'publish with a stale version must raise VERSION_CONFLICT';
  end;
  begin
    perform shifts_publish_week('copacabana', date '2031-02-03', 1, v_actor);
    raise exception 'expected SCHEDULE_NOT_FOUND';
  exception when others then
    assert sqlerrm = 'SCHEDULE_NOT_FOUND', 'publish of a missing week must raise SCHEDULE_NOT_FOUND';
  end;
  select version into v_n from sede_week_schedules where id = v_sched;
  v_res := shifts_publish_week('copacabana', v_week, v_n, v_actor);
  assert v_res->>'state' = 'PUBLICADO' and (v_res->>'version')::int = v_n + 1 and (v_res->>'noop')::boolean = false, 'publish must bump the version';
  assert (select count(*) from shift_history where schedule_id = v_sched and action = 'PUBLICAR') = 1, 'one PUBLICAR row expected';
  v_res := shifts_publish_week('copacabana', v_week, 999, v_actor);
  assert (v_res->>'noop')::boolean and (v_res->>'version')::int = v_n + 1, 'second publish must be a no-op whatever the version';
  assert (select count(*) from shift_history where schedule_id = v_sched and action = 'PUBLICAR') = 1, 'no-op must write no history';

  -- 9. Edit after publish: state stays PUBLICADO, history uses EDITAR_PUBLICADO.
  perform shifts_save_week('copacabana', v_week, v_n + 1, array['11111111'], jsonb_build_array(
    jsonb_build_object('cedula','11111111','fecha','2031-01-06','tipo','TRABAJO','start_time','10:00','end_time','17:00','break_minutes',60)), v_actor);
  select state into v_state from sede_week_schedules where id = v_sched;
  assert v_state = 'PUBLICADO', 'edit after publish keeps PUBLICADO';
  assert (select count(*) from shift_history where schedule_id = v_sched and action = 'EDITAR_PUBLICADO') >= 1, 'EDITAR_PUBLICADO row expected';

  raise notice 'ALL CHECKS PASSED';
end
$$;

rollback;
