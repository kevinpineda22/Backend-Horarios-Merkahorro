-- 005_payroll_cuts.sql: frozen payroll cuts ("cortes de nomina"): the cut, one line per employee
-- (zero-hour employees included), one row per employee-week, the audit history and the two RPCs.
-- Apply manually in the Supabase SQL editor AFTER 004, then run db/verification/005_payroll_cuts_verify.sql.
-- Idempotent where practical. Only the backend (service role) touches these objects: RLS on, no policies.
-- No extension is needed: the overlap guard is an EXCLUDE on a range type, which has a native gist opclass.
--
-- RPC error contract (raise exception message, mapped to HTTP by the API layer):
--   PAYROLL_CUT_OVERLAP      -> 409 (DETAIL = jsonb {id, from, to} of the PAGADO cut in the way)
--   PAYROLL_CUT_NOT_FOUND    -> 404 (void of a cut that does not exist)
--   PAYROLL_CUT_ALREADY_VOID -> 409 (void of a cut that is already ANULADO)
--   INVALID_SNAPSHOT         -> 400 (period is not 1-2 Monday-Sunday weeks / malformed snapshot)
--
-- ROLLBACK: see db/migrations/rollback/005_payroll_cuts.down.sql. Copy of it:
--   drop function if exists payroll_cut_void(bigint, text, uuid);
--   drop function if exists payroll_cut_save(date, date, jsonb, uuid);
--   drop table if exists payroll_cut_history; drop table if exists payroll_cut_weeks;
--   drop table if exists payroll_cut_lines; drop table if exists payroll_cuts;

-- ---------------------------------------------------------------------------
-- The cut. A voided cut (ANULADO) is kept as history and frees its dates.
-- ---------------------------------------------------------------------------
create table if not exists payroll_cuts (
  id bigint generated always as identity primary key,
  period_start date not null check (extract(isodow from period_start) = 1),
  period_end date not null check (extract(isodow from period_end) = 7),
  state text not null default 'PAGADO' check (state in ('PAGADO','ANULADO')),
  employees int not null check (employees >= 0),
  extras numeric(12,2) not null, nocturnas numeric(12,2) not null,
  dominicales numeric(12,2) not null, festivos numeric(12,2) not null,
  sundays jsonb not null, holidays jsonb not null,           -- calendar snapshot
  engine_version text not null,
  created_by uuid not null, created_at timestamptz not null default now(),
  voided_by uuid, voided_at timestamptz,
  void_reason text check (char_length(void_reason) <= 500),   -- optional
  constraint pc_len_chk check (period_end - period_start in (6, 13)),
  constraint pc_void_chk check (
    (state = 'PAGADO' and voided_by is null and voided_at is null)
 or (state = 'ANULADO' and voided_by is not null and voided_at is not null)),
  constraint payroll_cuts_paid_no_overlap exclude using gist
    (daterange(period_start, period_end, '[]') with &&) where (state = 'PAGADO'));

-- One line per employee, zero-hour employees included. Identity columns are a snapshot, no FK.
create table if not exists payroll_cut_lines (
  cut_id bigint not null references payroll_cuts (id),
  cedula text not null check (cedula ~ '^[0-9]{5,15}$'),
  nombre text, cargo text, sede_id text,
  siesa_code text check (siesa_code ~ '^[0-9]{3,4}$'),
  branch_source text check (branch_source in ('shift','sede','directory')),
  in_directory boolean not null,
  worked_hours numeric(8,2) not null check (worked_hours >= 0),
  extras numeric(8,2) not null check (extras >= 0),
  nocturnas numeric(8,2) not null check (nocturnas >= 0),
  dominicales numeric(8,2) not null check (dominicales >= 0),
  festivos numeric(8,2) not null check (festivos >= 0),
  sunday_festive_hours numeric(8,2) not null default 0,
  primary key (cut_id, cedula));
create index if not exists payroll_cut_lines_sede_idx on payroll_cut_lines (sede_id, cut_id);

create table if not exists payroll_cut_weeks (
  cut_id bigint not null, cedula text not null,
  week_start date not null check (extract(isodow from week_start) = 1),
  worked_hours numeric(8,2) not null, extras numeric(8,2) not null, nocturnas numeric(8,2) not null,
  dominicales numeric(8,2) not null, festivos numeric(8,2) not null,
  sunday_festive_hours numeric(8,2) not null default 0, has_overlap boolean not null default false,
  primary key (cut_id, cedula, week_start),
  foreign key (cut_id, cedula) references payroll_cut_lines (cut_id, cedula));

create table if not exists payroll_cut_history (
  id bigint generated always as identity primary key,
  cut_id bigint not null references payroll_cuts (id),
  action text not null check (action in ('CREAR','ANULAR')),
  actor uuid not null, at timestamptz not null default now(), detail jsonb);
create index if not exists payroll_cut_history_cut_idx on payroll_cut_history (cut_id, at desc, id desc);

alter table payroll_cuts enable row level security;
alter table payroll_cut_lines enable row level security;
alter table payroll_cut_weeks enable row level security;
alter table payroll_cut_history enable row level security;
revoke all on table payroll_cuts from anon, authenticated;
revoke all on table payroll_cut_lines from anon, authenticated;
revoke all on table payroll_cut_weeks from anon, authenticated;
revoke all on table payroll_cut_history from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Save. p_snapshot = {
--   sundays: [date], holidays: [{fecha, nombre}], engineVersion: text,
--   lines: [{cedula, nombre, cargo, sede_id, siesa_code, branch_source, in_directory,
--            worked_hours, extras, nocturnas, dominicales, festivos, sunday_festive_hours,
--            weeks: [{week_start, worked_hours, extras, nocturnas, dominicales, festivos,
--                     sunday_festive_hours, has_overlap}]}] }
-- Cut totals are the exact numeric sum of the lines; employees = number of lines.
-- Everything runs in one transaction, so a failure leaves no rows behind.
-- ---------------------------------------------------------------------------
create or replace function payroll_cut_save(p_from date, p_to date, p_snapshot jsonb, p_actor uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_cut payroll_cuts;
  v_conflict payroll_cuts;
  v_expected date[];
begin
  perform pg_advisory_xact_lock(hashtext('payroll:cuts'));

  -- Defensive: the API validates this already. Also protects daterange() from reversed bounds.
  if p_from is null or p_to is null or p_actor is null
     or extract(isodow from p_from) <> 1 or extract(isodow from p_to) <> 7
     or (p_to - p_from) not in (6, 13) then
    raise exception 'INVALID_SNAPSHOT';
  end if;

  select * into v_conflict from payroll_cuts
   where state = 'PAGADO' and daterange(period_start, period_end, '[]') && daterange(p_from, p_to, '[]')
   order by id limit 1;
  if found then
    raise exception 'PAYROLL_CUT_OVERLAP'
      using detail = jsonb_build_object('id', v_conflict.id, 'from', v_conflict.period_start, 'to', v_conflict.period_end)::text;
  end if;

  select array_agg(d::date order by d) into v_expected from generate_series(p_from, p_to, interval '7 days') d;

  if coalesce(jsonb_typeof(p_snapshot), '') <> 'object'
     or coalesce(jsonb_typeof(p_snapshot -> 'lines'), '') <> 'array'
     or coalesce(jsonb_typeof(p_snapshot -> 'sundays'), '') <> 'array'
     or coalesce(jsonb_typeof(p_snapshot -> 'holidays'), '') <> 'array'
     or coalesce(p_snapshot ->> 'engineVersion', '') = '' then
    raise exception 'INVALID_SNAPSHOT';
  end if;

  -- Every line needs its identity and numbers, and EXACTLY the weeks of the period.
  if exists (
       select 1
         from jsonb_to_recordset(p_snapshot -> 'lines') as l(
           cedula text, in_directory boolean, worked_hours numeric, extras numeric,
           nocturnas numeric, dominicales numeric, festivos numeric, weeks jsonb)
        where l.cedula is null or l.in_directory is null
           or l.worked_hours is null or l.extras is null or l.nocturnas is null
           or l.dominicales is null or l.festivos is null
           or case when jsonb_typeof(l.weeks) = 'array' then
                (select array_agg(w.week_start order by w.week_start)
                   from jsonb_to_recordset(l.weeks) as w(week_start date)) end
              is distinct from v_expected
           or case when jsonb_typeof(l.weeks) = 'array' then exists (
                select 1 from jsonb_to_recordset(l.weeks) as w(
                  worked_hours numeric, extras numeric, nocturnas numeric, dominicales numeric, festivos numeric)
                 where w.worked_hours is null or w.extras is null or w.nocturnas is null
                    or w.dominicales is null or w.festivos is null) else true end)
     or exists (
       select 1 from jsonb_to_recordset(p_snapshot -> 'lines') as l(cedula text)
        group by l.cedula having count(*) > 1) then
    raise exception 'INVALID_SNAPSHOT';
  end if;

  begin
    insert into payroll_cuts (period_start, period_end, employees, extras, nocturnas, dominicales, festivos,
                              sundays, holidays, engine_version, created_by)
    select p_from, p_to, count(*), coalesce(sum(l.extras), 0), coalesce(sum(l.nocturnas), 0),
           coalesce(sum(l.dominicales), 0), coalesce(sum(l.festivos), 0),
           p_snapshot -> 'sundays', p_snapshot -> 'holidays', p_snapshot ->> 'engineVersion', p_actor
      from jsonb_to_recordset(p_snapshot -> 'lines') as l(extras numeric, nocturnas numeric, dominicales numeric, festivos numeric)
    returning * into v_cut;

    insert into payroll_cut_lines (cut_id, cedula, nombre, cargo, sede_id, siesa_code, branch_source, in_directory,
                                   worked_hours, extras, nocturnas, dominicales, festivos, sunday_festive_hours)
    select v_cut.id, l.cedula, l.nombre, l.cargo, l.sede_id, l.siesa_code, l.branch_source, l.in_directory,
           l.worked_hours, l.extras, l.nocturnas, l.dominicales, l.festivos, coalesce(l.sunday_festive_hours, 0)
      from jsonb_to_recordset(p_snapshot -> 'lines') as l(
        cedula text, nombre text, cargo text, sede_id text, siesa_code text, branch_source text, in_directory boolean,
        worked_hours numeric, extras numeric, nocturnas numeric, dominicales numeric, festivos numeric,
        sunday_festive_hours numeric);

    insert into payroll_cut_weeks (cut_id, cedula, week_start, worked_hours, extras, nocturnas, dominicales, festivos,
                                   sunday_festive_hours, has_overlap)
    select v_cut.id, l.cedula, w.week_start, w.worked_hours, w.extras, w.nocturnas, w.dominicales, w.festivos,
           coalesce(w.sunday_festive_hours, 0), coalesce(w.has_overlap, false)
      from jsonb_to_recordset(p_snapshot -> 'lines') as l(cedula text, weeks jsonb),
           jsonb_to_recordset(l.weeks) as w(
             week_start date, worked_hours numeric, extras numeric, nocturnas numeric, dominicales numeric,
             festivos numeric, sunday_festive_hours numeric, has_overlap boolean);

    insert into payroll_cut_history (cut_id, action, actor, detail)
    values (v_cut.id, 'CREAR', p_actor,
            jsonb_build_object('from', p_from, 'to', p_to, 'employees', v_cut.employees,
                               'engineVersion', v_cut.engine_version));
  exception when exclusion_violation then
    -- Backstop of the advisory lock: the constraint is the real guarantee.
    select * into v_conflict from payroll_cuts
     where state = 'PAGADO' and daterange(period_start, period_end, '[]') && daterange(p_from, p_to, '[]')
     order by id limit 1;
    raise exception 'PAYROLL_CUT_OVERLAP'
      using detail = case
        when v_conflict.id is null then 'null'  -- no PAGADO row found: details.cut is null
        else jsonb_build_object('id', v_conflict.id, 'from', v_conflict.period_start, 'to', v_conflict.period_end)::text
      end;
  end;

  return to_jsonb(v_cut);
end
$$;

-- ---------------------------------------------------------------------------
-- Void: PAGADO -> ANULADO (soft). Who and when are recorded; the reason is optional.
-- ---------------------------------------------------------------------------
create or replace function payroll_cut_void(p_id bigint, p_reason text, p_actor uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_cut payroll_cuts;
begin
  perform pg_advisory_xact_lock(hashtext('payroll:cuts'));

  select * into v_cut from payroll_cuts where id = p_id for update;
  if not found then
    raise exception 'PAYROLL_CUT_NOT_FOUND';
  end if;
  if v_cut.state = 'ANULADO' then
    raise exception 'PAYROLL_CUT_ALREADY_VOID';
  end if;

  update payroll_cuts
     set state = 'ANULADO', voided_by = p_actor, voided_at = now(), void_reason = nullif(btrim(p_reason), '')
   where id = p_id
  returning * into v_cut;

  insert into payroll_cut_history (cut_id, action, actor, detail)
  values (v_cut.id, 'ANULAR', p_actor, jsonb_build_object('reason', v_cut.void_reason));

  return to_jsonb(v_cut);
end
$$;

-- Executable by service_role only (Supabase grants EXECUTE on new functions to anon/authenticated).
revoke all on function payroll_cut_save(date, date, jsonb, uuid) from public;
revoke all on function payroll_cut_void(bigint, text, uuid) from public;
revoke all on function payroll_cut_save(date, date, jsonb, uuid) from anon, authenticated;
revoke all on function payroll_cut_void(bigint, text, uuid) from anon, authenticated;
grant execute on function payroll_cut_save(date, date, jsonb, uuid) to service_role;
grant execute on function payroll_cut_void(bigint, text, uuid) to service_role;
