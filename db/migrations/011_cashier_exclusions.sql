-- 011_cashier_exclusions.sql: "Solo surtidor / no programar en caja" - employees SIESA lists as cashiers who must NOT
-- count as cashiers in the scheduler. Leaders set and revert it in the app; SIESA is never touched.
-- Apply manually in the Supabase SQL editor, then run db/verification/011_cashier_exclusions_verify.sql.
-- Idempotent. Only the backend (service role) touches this table: RLS stays on, no policies.
--
-- One ACTIVE row per cedula (partial unique index). Reverting is a soft revoke (revoked_at / revoked_by), so the rows
-- themselves are the history: who excluded whom, where, why and when it was lifted.
--   * cedula     normalized (digits only, no leading zeros), same key as the rest of the system.
--   * sede_id    the sede the employee belonged to when the exclusion was set (authorization / audit). No FK: the
--                employee directory can hold sedes that are not mapped in sugerido_sedes.
--   * motivo     optional, up to 200 characters.
--
-- DEPLOY: apply this BEFORE deploying the backend. GET /api/empleados reads this table on every call, so it answers
-- 500 without it. The old backend is unaffected by the new table.
-- ROLLBACK: db/migrations/rollback/011_cashier_exclusions.down.sql (drops the table: the history is lost).

create table if not exists cashier_exclusions (
  id uuid primary key default gen_random_uuid(),
  cedula text not null check (cedula ~ '^[0-9]{5,15}$'),
  sede_id text,
  motivo text check (motivo is null or char_length(motivo) <= 200),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_by uuid,
  revoked_at timestamptz,
  constraint cashier_exclusions_revoke_chk check ((revoked_at is null) = (revoked_by is null))
);

create unique index if not exists cashier_exclusions_active_cedula_idx on cashier_exclusions (cedula) where revoked_at is null;
create index if not exists cashier_exclusions_cedula_idx on cashier_exclusions (cedula, created_at desc);

alter table cashier_exclusions enable row level security;
revoke all on table cashier_exclusions from anon, authenticated;
