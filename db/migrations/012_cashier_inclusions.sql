-- 012_cashier_inclusions.sql: "Programar en caja" - employees whose SIESA cargo is not a cashier one (CAJERO PAC,
-- Auxiliar de Fruver...) but who DO work the register. Leaders set and revert it in the app; SIESA is never touched.
-- Apply manually in the Supabase SQL editor, then run db/verification/012_cashier_inclusions_verify.sql.
-- Idempotent.
--
-- It reuses cashier_exclusions (011): one more column, `kind`.
--   * 'exclude'  "Solo surtidor / no programar en caja" (every row written before 012).
--   * 'include'  "Programar en caja" with another cargo.
-- The partial unique index of 011 stays: a person has at most ONE active mark, of either kind. Reverting is the same
-- soft revoke, so the rows keep being the history.
--
-- DEPLOY: apply this BEFORE deploying the backend. GET /api/empleados selects `kind` on every call, so it answers 500
-- without it. The backend that predates 012 is unaffected (it never reads the column, and new rows default to 'exclude'
-- only when written by it).
-- ROLLBACK: db/migrations/rollback/012_cashier_inclusions.down.sql (revokes the include rows, then drops the column).

alter table cashier_exclusions add column if not exists kind text not null default 'exclude';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cashier_exclusions_kind_chk') then
    alter table cashier_exclusions add constraint cashier_exclusions_kind_chk check (kind in ('exclude', 'include'));
  end if;
end $$;
