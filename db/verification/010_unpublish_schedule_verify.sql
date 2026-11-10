-- 010_unpublish_schedule_verify.sql: manual verification of shifts_unpublish_week.
-- Run in the Supabase SQL editor AFTER 010 (and 004, 005, the seed). NEVER run it as part of tests.
-- Works in a far-future week (2031-01-06), inside ONE transaction that ends with ROLLBACK. Expected failures are caught in
-- nested BEGIN/EXCEPTION blocks. A final "ALL CHECKS PASSED" notice means every check held. Needs sede copacabana.

begin;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
  v_week  date := date '2031-01-06';
  v_res jsonb;
  v_sched uuid;
  v_n int;
  v_msg text;
begin
  assert not has_function_privilege('anon', 'shifts_unpublish_week(text, date, int, uuid)', 'execute')
     and not has_function_privilege('authenticated', 'shifts_unpublish_week(text, date, int, uuid)', 'execute'), 'anon/authenticated cannot execute';
  assert has_function_privilege('service_role', 'shifts_unpublish_week(text, date, int, uuid)', 'execute'), 'service_role can execute';

  -- No schedule yet.
  begin
    perform shifts_unpublish_week('copacabana', v_week, 1, v_actor);
    raise exception 'must fail';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    assert v_msg = 'SCHEDULE_NOT_FOUND', 'unknown week: ' || v_msg;
  end;

  -- Draft -> NOT_PUBLISHED.
  v_res := shifts_save_week('copacabana', v_week, 0, array['11111111'], jsonb_build_array(
    jsonb_build_object('cedula','11111111','fecha','2031-01-06','tipo','TRABAJO','start_time','08:00','end_time','17:00','break_minutes',60)), v_actor);
  v_sched := (v_res->>'id')::uuid;
  begin
    perform shifts_unpublish_week('copacabana', v_week, 1, v_actor);
    raise exception 'must fail';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    assert v_msg = 'NOT_PUBLISHED', 'draft: ' || v_msg;
  end;

  -- Published -> wrong version, then ok.
  perform shifts_publish_week('copacabana', v_week, 1, v_actor); -- version 2
  begin
    perform shifts_unpublish_week('copacabana', v_week, 1, v_actor);
    raise exception 'must fail';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    assert v_msg = 'VERSION_CONFLICT', 'stale version: ' || v_msg;
  end;

  -- A paid cut over the week blocks; a voided one does not.
  insert into payroll_cuts (period_start, period_end, state, employees, extras, nocturnas, dominicales, festivos, sundays, holidays, engine_version, created_by)
  values (date '2031-01-06', date '2031-01-12', 'PAGADO', 0, 0, 0, 0, 0, '[]'::jsonb, '[]'::jsonb, 'verify', v_actor);
  begin
    perform shifts_unpublish_week('copacabana', v_week, 2, v_actor);
    raise exception 'must fail';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    assert v_msg = 'PAYROLL_CUT_PAID', 'paid cut: ' || v_msg;
  end;
  update payroll_cuts set state = 'ANULADO', voided_by = v_actor, voided_at = now() where period_start = date '2031-01-06' and engine_version = 'verify';

  v_res := shifts_unpublish_week('copacabana', v_week, 2, v_actor);
  assert v_res->>'state' = 'BORRADOR' and (v_res->>'version')::int = 3, 'back to BORRADOR, version 3';
  assert v_res->>'publishedAt' is null and v_res->>'publishedBy' is null, 'published_* cleared';
  select count(*) into v_n from shift_history where schedule_id = v_sched and action = 'DESPUBLICAR' and schedule_version = 3 and actor = v_actor;
  assert v_n = 1, 'one DESPUBLICAR history row';
  select count(*) into v_n from shifts where schedule_id = v_sched;
  assert v_n = 1, 'shifts untouched';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
