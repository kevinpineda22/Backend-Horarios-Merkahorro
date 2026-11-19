-- 015_schedule_teams_verify.sql: manual verification. Run in the Supabase SQL editor AFTER 015. NEVER in tests.
-- One transaction that ends with ROLLBACK. A final "ALL CHECKS PASSED" notice means every check held.

begin;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
  v_sede text;
  v_week date := date '2031-01-06';
  v_res jsonb;
  v_caj uuid;
  v_oth uuid;
begin
  assert exists (select 1 from information_schema.columns where table_name = 'sede_week_schedules' and column_name = 'team_key'), 'team_key exists';
  assert exists (select 1 from information_schema.columns where table_name = 'schedule_publish_snapshots' and column_name = 'team_key'), 'snapshots.team_key exists';
  assert not exists (select 1 from sede_week_schedules where team_key is null), 'no null team';
  assert has_function_privilege('service_role', 'shifts_save_week(text, date, text, int, text[], jsonb, uuid)', 'execute'), 'service_role can save';
  assert not has_function_privilege('anon', 'shifts_publish_week(text, date, text, int, uuid)', 'execute'), 'anon cannot publish';
  assert not exists (select 1 from pg_proc where proname = 'shifts_save_week' and pronargs = 6), 'old 6-arg save is gone';
  assert not exists (select 1 from pg_proc where proname = 'shifts_unpublish_week' and pronargs = 4), 'old 4-arg unpublish is gone';

  begin
    insert into sede_week_schedules (sede_id, week_start, team_key, created_by, updated_by)
    values ('x', date '2031-01-06', 'lowercase', v_actor, v_actor);
    raise exception 'team_key format must be checked';
  exception when check_violation then null;
  end;

  select sede_id into v_sede from sugerido_sedes limit 1;
  if v_sede is null then
    raise notice 'No sede yet: behaviour checks skipped';
  else
    -- two teams, same sede-week, independent versions
    v_res := shifts_save_week(v_sede, v_week, 'CAJEROS', 0, array['99999991'],
      '[{"cedula":"99999991","fecha":"2031-01-06","tipo":"TRABAJO","start_time":"08:00","end_time":"17:00","break_minutes":60}]'::jsonb, v_actor);
    v_caj := (v_res ->> 'id')::uuid;
    assert v_res ->> 'teamKey' = 'CAJEROS' and (v_res ->> 'version')::int = 1, 'cashier schedule created';

    v_res := shifts_save_week(v_sede, v_week, 'CARGO:CARNICERO', 0, array['99999992'],
      '[{"cedula":"99999992","fecha":"2031-01-06","tipo":"TRABAJO","start_time":"08:00","end_time":"17:00","break_minutes":60}]'::jsonb, v_actor);
    v_oth := (v_res ->> 'id')::uuid;
    assert v_oth <> v_caj and (v_res ->> 'version')::int = 1, 'second team has its own document and version';

    -- cross-team guard: the same person-day cannot live in two teams of the sede-week
    begin
      perform shifts_save_week(v_sede, v_week, 'CARGO:CARNICERO', 1, array['99999991'],
        '[{"cedula":"99999991","fecha":"2031-01-06","tipo":"DESCANSO"}]'::jsonb, v_actor);
      raise exception 'SHIFT_IN_OTHER_TEAM expected';
    exception when others then
      assert sqlerrm = 'SHIFT_IN_OTHER_TEAM', 'cross-team guard raises SHIFT_IN_OTHER_TEAM';
    end;

    -- publishing one team leaves the other as a draft
    perform shifts_publish_week(v_sede, v_week, 'CAJEROS', 1, v_actor);
    assert (select state from sede_week_schedules where id = v_caj) = 'PUBLICADO', 'cashiers published';
    assert (select state from sede_week_schedules where id = v_oth) = 'BORRADOR', 'other team untouched';

    perform shifts_unpublish_week(v_sede, v_week, 'CAJEROS', 2, v_actor);
    assert (select state from sede_week_schedules where id = v_caj) = 'BORRADOR', 'cashiers unpublished';
  end if;

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
