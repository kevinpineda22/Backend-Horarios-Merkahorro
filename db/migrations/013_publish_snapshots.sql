-- 013_publish_snapshots.sql: what the system recommended, what it suggested and what the leader published, frozen at the
-- moment a week is published. It lets us compare, per sede and week, how leaders use the scheduler (published as
-- suggested, or changed) and how each version covers the recommendation.
-- Apply manually in the Supabase SQL editor, then run db/verification/013_publish_snapshots_verify.sql. Idempotent.
-- Only the backend (service role) touches this table: RLS on, no policies.
--
-- One row per publication (a week published, unpublished and published again has two rows: both are history).
--   * recommendation  jsonb, as the client showed it: { runVersion, dataAsOf, registers, slots: [{ fecha, franja, final }] }.
--   * suggested       jsonb, the schedule the generator proposed: { shifts: [{ cedula, fecha, tipo, startTime, ... }] }.
--   * published       jsonb, the rows of the week read from `shifts` right after publishing (never from the client).
-- recommendation / suggested can be null (an older client, or no recommendation that week).
--
-- DEPLOY: apply this BEFORE deploying the backend. Publishing never fails without it (the snapshot is best effort and
-- is only logged), but every publication made before it is applied is lost for the comparison.
-- ROLLBACK: db/migrations/rollback/013_publish_snapshots.down.sql (keeps a copy, then drops the table).

create table if not exists schedule_publish_snapshots (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references sede_week_schedules (id) on delete cascade,
  sede_id text not null,
  week_start date not null,
  schedule_version int not null,
  published_by uuid not null,
  published_at timestamptz not null default now(),
  recommendation jsonb,
  suggested jsonb,
  published jsonb not null
);

create index if not exists schedule_publish_snapshots_week_idx on schedule_publish_snapshots (sede_id, week_start, published_at desc);

alter table schedule_publish_snapshots enable row level security;
revoke all on table schedule_publish_snapshots from anon, authenticated;
