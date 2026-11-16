-- 014_overtime_requests.sql: requests for overtime hours beyond the team's 10 h a week. A leader asks for a number of
-- hours and a reason for one sede-week; the approvers (Anny, Ramiro) approve or reject it in Autorizaciones. ONE
-- decision is enough. Approved hours raise that sede-week's overtime budget in the scheduler.
-- Apply manually in the Supabase SQL editor, then run db/verification/014_overtime_requests_verify.sql. Idempotent.
-- Only the backend (service role) touches this table: RLS on, no policies.
--
--   * status      PENDIENTE -> APROBADA | RECHAZADA (one decision; decided_by / decided_at travel together).
--   * one PENDIENTE request per sede-week at a time (partial unique index); decided ones are the history.
--
-- DEPLOY: apply this BEFORE deploying the backend (the overtime routes read and write this table).
-- ROLLBACK: db/migrations/rollback/014_overtime_requests.down.sql (keeps a copy, then drops the table).

create table if not exists overtime_requests (
  id uuid primary key default gen_random_uuid(),
  sede_id text not null,
  week_start date not null check (extract(isodow from week_start) = 1),
  hours numeric(5, 1) not null check (hours > 0 and hours <= 100),
  motivo text not null check (char_length(motivo) between 1 and 500),
  status text not null default 'PENDIENTE' check (status in ('PENDIENTE', 'APROBADA', 'RECHAZADA')),
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_comment text check (decision_comment is null or char_length(decision_comment) <= 500),
  constraint overtime_requests_decision_chk check (
    (status = 'PENDIENTE' and decided_by is null and decided_at is null)
    or (status <> 'PENDIENTE' and decided_by is not null and decided_at is not null)
  )
);

create unique index if not exists overtime_requests_pending_idx on overtime_requests (sede_id, week_start) where status = 'PENDIENTE';
create index if not exists overtime_requests_week_idx on overtime_requests (sede_id, week_start, requested_at desc);
create index if not exists overtime_requests_status_idx on overtime_requests (status, requested_at desc);

alter table overtime_requests enable row level security;
revoke all on table overtime_requests from anon, authenticated;
