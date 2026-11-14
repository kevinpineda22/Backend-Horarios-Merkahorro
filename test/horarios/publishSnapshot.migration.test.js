import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../../db/${rel}`, import.meta.url), "utf8");
const flat = (s) => s.toLowerCase().replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

test("migration 013: one snapshot row per publication, tied to the schedule, closed to the clients", () => {
  const sql = flat(read("migrations/013_publish_snapshots.sql"));
  assert.ok(sql.includes("create table if not exists schedule_publish_snapshots ("));
  assert.ok(sql.includes("schedule_id uuid not null references sede_week_schedules (id) on delete cascade"));
  for (const column of ["recommendation jsonb", "suggested jsonb", "published jsonb not null", "schedule_version int not null", "published_by uuid not null"]) {
    assert.ok(sql.includes(column), column);
  }
  assert.ok(sql.includes("alter table schedule_publish_snapshots enable row level security"));
  assert.ok(sql.includes("revoke all on table schedule_publish_snapshots from anon, authenticated"));
  assert.doesNotMatch(sql, /create policy/);
  assert.match(read("migrations/013_publish_snapshots.sql"), /apply this BEFORE deploying the backend/i);
});

test("migration 013: rollback keeps a copy before dropping; verify ends in ROLLBACK", () => {
  const d = flat(read("migrations/rollback/013_publish_snapshots.down.sql"));
  assert.ok(d.indexOf("schedule_publish_snapshots_backup_013") < d.indexOf("drop table if exists schedule_publish_snapshots"));
  const v = flat(read("verification/013_publish_snapshots_verify.sql")).trim();
  assert.match(v, /^begin;/);
  assert.match(v, /rollback;$/);
  assert.ok(v.includes("all checks passed"));
});
