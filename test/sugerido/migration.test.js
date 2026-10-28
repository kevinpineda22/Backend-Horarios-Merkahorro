import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static checks only: the migration is applied manually and never run by tests.
const sql = readFileSync(new URL("../../db/migrations/001_sugerido.sql", import.meta.url), "utf8");
const norm = sql.toLowerCase().replace(/\s+/g, " ");

const TABLES = ["sugerido_settings", "sugerido_sedes", "sugerido_runs", "sugerido_slots", "sugerido_overrides", "sugerido_access"];

test("creates every table with RLS enabled and no policies", () => {
  for (const t of TABLES) {
    assert.match(norm, new RegExp(`create table (if not exists )?${t} `), `missing table ${t}`);
    assert.match(norm, new RegExp(`alter table ${t} enable row level security`), `RLS off for ${t}`);
  }
  assert.doesNotMatch(norm, /create policy/);
});

test("settings: single row id=1 seeded with confirmed defaults", () => {
  assert.match(norm, /id int primary key check \(id = 1\)/);
  assert.match(norm, /ordinary_weekly_hours numeric not null default 42/);
  assert.match(norm, /overtime_weekly_hours numeric not null default 12/);
  assert.match(norm, /daily_max_hours numeric not null default 10/);
  assert.match(norm, /utilization numeric not null default 0\.85/);
  assert.match(norm, /max_working_days_per_week int not null default 6/);
  assert.match(norm, /min_cashiers int not null default 1/);
  assert.match(norm, /insert into sugerido_settings \(id\) values \(1\) on conflict/);
});

test("runs are versioned per sede and week; overrides reject negatives", () => {
  assert.match(norm, /extract\(isodow from week_start\) = 1/);
  assert.match(norm, /unique \(sede_id, week_start, version\)/);
  assert.match(norm, /headcount int not null check \(headcount >= 0\)/);
});

test("save_run and apply_overrides exist, lock, and are restricted to service_role", () => {
  assert.match(norm, /create or replace function sugerido_save_run\(p_run jsonb, p_slots jsonb\)/);
  assert.match(norm, /pg_advisory_xact_lock/);
  assert.match(norm, /create or replace function sugerido_apply_overrides\(p_sede text, p_items jsonb, p_user uuid\)/);
  for (const fn of ["sugerido_save_run(jsonb, jsonb)", "sugerido_apply_overrides(text, jsonb, uuid)"]) {
    assert.ok(norm.includes(`revoke all on function ${fn} from public`), `no revoke for ${fn}`);
    assert.ok(norm.includes(`revoke all on function ${fn} from anon, authenticated`), `no anon/authenticated revoke for ${fn}`);
    assert.ok(norm.includes(`grant execute on function ${fn} to service_role`), `no grant for ${fn}`);
  }
  assert.match(norm, /security invoker/);
});

test("settings have range CHECK constraints", () => {
  assert.match(norm, /utilization numeric not null default 0\.85 check \(utilization > 0 and utilization <= 1\)/);
  assert.match(norm, /max_working_days_per_week int not null default 6 check \(max_working_days_per_week between 1 and 7\)/);
  for (const col of ["ordinary_weekly_hours", "overtime_weekly_hours", "daily_max_hours", "min_cashiers", "stale_after_days"]) {
    assert.match(norm, new RegExp(String.raw`check \(${col} >= 0\)`), `no >= 0 check for ${col}`);
  }
});

test("save_run rejects null or empty slots", () => {
  assert.match(norm, /p_slots is null or jsonb_typeof\(p_slots\) <> 'array' or jsonb_array_length\(p_slots\) = 0/);
  assert.match(norm, /raise exception 'sugerido_save_run: p_slots must be a non-empty array'/);
});
