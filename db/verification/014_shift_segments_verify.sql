-- 014_shift_segments_verify.sql: manual verification. Run in the Supabase SQL editor AFTER 014. NEVER in tests.
-- One transaction that ends with ROLLBACK. A final "ALL CHECKS PASSED" notice means every check held.

begin;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
  v_sede text;
  v_week date := date '2031-01-06';
  v_sch uuid;
  v_shift uuid;
  v_seg jsonb := '[{"role":"caja","from":"08:00","to":"12:00"},{"role":"surtido","from":"13:00","to":"17:00"}]';
begin
  assert exists (select 1 from information_schema.columns where table_name = 'shifts' and column_name = 'segments'), 'shifts.segments exists';
  assert has_function_privilege('service_role', 'shifts_publish_week(text, date, int, uuid, jsonb)', 'execute'), 'service_role can publish with segments';
  assert not has_function_privilege('anon', 'shifts_publish_week(text, date, int, uuid, jsonb)', 'execute'), 'anon cannot publish';

  select sede_id into v_sede from sugerido_sedes limit 1;
  if v_sede is null then
    raise notice 'No sede yet: behaviour checks skipped';
  else
    perform shifts_save_week(v_sede, v_week, 0, array['99999991'],
      '[{"cedula":"99999991","fecha":"2031-01-06","tipo":"TRABAJO","start_time":"08:00","end_time":"17:00","break_minutes":60,"lunch_start":"12:00"},
        {"cedula":"99999991","fecha":"2031-01-07","tipo":"DESCANSO"}]'::jsonb, v_actor);
    select id into v_sch from sede_week_schedules where sede_id = v_sede and week_start = v_week;
    select id into v_shift from shifts where schedule_id = v_sch and cedula = '99999991' and fecha = v_week;

    -- publish with segments: stored on the worked shift only
    perform shifts_publish_week(v_sede, v_week, 1, v_actor,
      jsonb_build_array(jsonb_build_object('cedula', '99999991', 'fecha', '2031-01-06', 'segments', v_seg)));
    assert (select segments from shifts where id = v_shift) = v_seg, 'segments stored at publish';
    assert (select segments from shifts where schedule_id = v_sch and fecha = date '2031-01-07') is null, 'rest day has no segments';

    -- editing the published week with new segments replaces them
    perform shifts_save_week(v_sede, v_week, 2, array['99999991'],
      '[{"cedula":"99999991","fecha":"2031-01-06","tipo":"TRABAJO","start_time":"08:00","end_time":"16:00","break_minutes":60,"lunch_start":"12:00"},
        {"cedula":"99999991","fecha":"2031-01-07","tipo":"DESCANSO"}]'::jsonb, v_actor,
      '[{"cedula":"99999991","fecha":"2031-01-06","segments":[{"role":"surtido","from":"08:00","to":"16:00"}]}]'::jsonb);
    assert (select segments -> 0 ->> 'role' from shifts where id = v_shift) = 'surtido', 'segments refreshed on published edit';

    -- an edit through the OLD save function (no segments) resets them
    perform shifts_save_week(v_sede, v_week, 3, array['99999991'],
      '[{"cedula":"99999991","fecha":"2031-01-06","tipo":"TRABAJO","start_time":"09:00","end_time":"16:00","break_minutes":60,"lunch_start":"12:00"},
        {"cedula":"99999991","fecha":"2031-01-07","tipo":"DESCANSO"}]'::jsonb, v_actor);
    assert (select segments from shifts where id = v_shift) is null, 'stale segments reset by the trigger';

    -- unpublish clears them
    perform shifts_apply_segments(v_sch, null, jsonb_build_array(jsonb_build_object('cedula', '99999991', 'fecha', '2031-01-06', 'segments', v_seg)));
    assert (select segments from shifts where id = v_shift) = v_seg, 'helper stores segments';
    perform shifts_unpublish_week(v_sede, v_week, 4, v_actor);
    assert (select segments from shifts where id = v_shift) is null, 'unpublish clears segments';

    -- constraint: only arrays
    begin
      update shifts set segments = '{"a":1}'::jsonb where id = v_shift;
      raise exception 'segments must be an array';
    exception when check_violation then null;
    end;
  end if;

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
