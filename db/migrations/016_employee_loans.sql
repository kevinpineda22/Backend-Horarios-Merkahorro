-- 016_employee_loans.sql: loans of an employee between sedes. A leader lends one of her sede's people to another sede
-- for ONE full week; it applies at once (the receiving leader does not accept). During that week the person leaves her
-- home sede's team and cashier pool and joins the host sede's.
-- Apply manually in the Supabase SQL editor, then run db/verification/016_employee_loans_verify.sql.
-- Idempotent. Only the backend (service role) touches this table: RLS stays on, no policies.
--
-- One ACTIVE loan per (cedula, week_start) (partial unique index). Cancelling is a soft revoke (revoked_at / revoked_by),
-- so the rows themselves are the history: who lent whom, to where, why and when it was cancelled.
--   * cedula       normalized (digits only, no leading zeros), same key as the rest of the system.
--   * home_sede_id the sede the person belongs to (the one that lends her). FK to sugerido_sedes.
--   * host_sede_id the sede that receives her for the week. FK to sugerido_sedes.
--   * week_start   the Monday of the lent week.
--   * motivo       optional, up to 200 characters.
--
-- DEPLOY: apply this before (or right after) deploying the backend. Without the table, schedule saves and the sugerido
-- read no loans, and creating or cancelling a loan answers 503. The old backend is unaffected by the new table.
-- ROLLBACK: db/migrations/rollback/016_employee_loans.down.sql (drops the table: the history is lost).

create table if not exists employee_loans (
  id uuid primary key default gen_random_uuid(),
  cedula text not null check (cedula ~ '^[0-9]{5,15}$'),
  home_sede_id text not null references sugerido_sedes (sede_id),
  host_sede_id text not null references sugerido_sedes (sede_id),
  week_start date not null check (extract(isodow from week_start) = 1),
  motivo text check (motivo is null or char_length(motivo) <= 200),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_by uuid,
  revoked_at timestamptz,
  constraint employee_loans_sedes_chk check (home_sede_id <> host_sede_id),
  constraint employee_loans_revoke_chk check ((revoked_at is null) = (revoked_by is null))
);

create unique index if not exists employee_loans_active_cedula_week_idx on employee_loans (cedula, week_start) where revoked_at is null;
create index if not exists employee_loans_active_week_idx on employee_loans (week_start) where revoked_at is null;

alter table employee_loans enable row level security;
revoke all on table employee_loans from anon, authenticated;
