-- 008_sugerido_registers.sql: manual override of the number of physical checkout registers ("puestos de pago") per sede.
-- Apply manually in the Supabase SQL editor, then run db/verification/008_sugerido_registers_verify.sql.
-- Idempotent. Only the backend (service role) touches this table: RLS stays on, no policies.
--
-- What changes:
--   * sugerido_sedes.registers_override (nullable int, 1..50). NULL = no override: the backend derives the count from the
--     sales database (distinct bodega + caja in the last 60 days). The effective count (override, else derived) caps how
--     many cashiers the recommendation suggests at the same time.
--
-- Nothing here can reject an existing row: the new column starts NULL.
--
-- DEPLOY: apply this BEFORE deploying the backend. The new backend selects registers_override on every sugerido_sedes
-- read (sede list, week view, runs), so it breaks before 008. The old backend keeps working after 008.
-- ROLLBACK: see db/migrations/rollback/008_sugerido_registers.down.sql (destroys the overrides).

alter table sugerido_sedes add column if not exists registers_override int;

alter table sugerido_sedes drop constraint if exists sugerido_sedes_registers_override_chk;
alter table sugerido_sedes add constraint sugerido_sedes_registers_override_chk
  check (registers_override is null or registers_override between 1 and 50);

-- Re-assert the access model (already in place since 001; harmless to repeat).
alter table sugerido_sedes enable row level security;
revoke all on table sugerido_sedes from anon, authenticated;
