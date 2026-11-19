import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static checks only: the migration is applied manually and never run by tests.
const read = (rel) => readFileSync(new URL(`../../db/${rel}`, import.meta.url), "utf8");
const flat = (s) => s.toLowerCase().replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
const sql = flat(read("migrations/015_schedule_teams.sql"));

// Text of the `create or replace function <name>(<args>)` whose argument list starts with `argsStart`.
function fn(name, argsStart) {
  const re = new RegExp(`create or replace function ${name}\\(\\s*${argsStart}[\\s\\S]*?\\$\\$;`, "i");
  const m = re.exec(sql);
  assert.ok(m, `${name}(${argsStart}) not found`);
  return m[0];
}

test("migration 015: team_key column, format check and the new unique key", () => {
  assert.ok(sql.includes("alter table sede_week_schedules add column if not exists team_key text not null default 'cajeros'"));
  assert.ok(sql.includes("constraint sws_team_key_chk"));
  assert.ok(sql.includes("team_key in ('cajeros', 'sin_cargo') or team_key like 'cargo:_%'"));
  assert.ok(sql.includes("pg_get_constraintdef(oid) = 'unique (sede_id, week_start)'"));
  assert.ok(sql.includes("unique (sede_id, week_start, team_key)"));
  assert.doesNotMatch(sql, /drop constraint[^;]*unique \(id, sede_id\)/);
});

test("migration 015: snapshots keep the team and their week index includes it", () => {
  assert.ok(sql.includes("alter table schedule_publish_snapshots add column if not exists team_key text not null default 'cajeros'"));
  assert.ok(sql.includes("on schedule_publish_snapshots (sede_id, week_start, team_key, published_at desc)"));
});

test("migration 015: the pre-team RPC signatures are dropped so stale clients fail loudly", () => {
  for (const sig of [
    "shifts_save_week(text, date, int, text[], jsonb, uuid, jsonb)",
    "shifts_save_week(text, date, int, text[], jsonb, uuid)",
    "shifts_publish_week(text, date, int, uuid, jsonb)",
    "shifts_publish_week(text, date, int, uuid)",
    "shifts_unpublish_week(text, date, int, uuid)",
  ]) {
    assert.ok(sql.includes(`drop function if exists ${sig}`), sig);
  }
});

test("migration 015: every RPC takes p_team, looks the week up by team and locks per team", () => {
  const lock = "pg_advisory_xact_lock(hashtext('shifts:week:' || p_sede || ':' || to_char(p_week, 'yyyy-mm-dd') || ':' || p_team))";
  for (const [name, args] of [
    ["shifts_save_week", "p_sede text, p_week date, p_team text, p_expected_version int, p_cedulas text\\[\\], p_shifts jsonb, p_actor uuid\\)"],
    ["shifts_publish_week", "p_sede text, p_week date, p_team text, p_expected_version int, p_actor uuid\\)"],
    ["shifts_unpublish_week", "p_sede text, p_week date, p_team text, p_expected_version int, p_actor uuid\\)"],
  ]) {
    const body = fn(name, args);
    assert.ok(body.includes(lock), `${name} lock`);
    assert.ok(body.includes("and team_key = p_team for update"), `${name} lookup`);
    assert.ok(body.includes("'teamkey', v_sch.team_key"), `${name} returns the team`);
  }
  assert.ok(fn("shifts_save_week", "p_sede text, p_week date, p_team text, p_expected_version int, p_cedulas text\\[\\], p_shifts jsonb, p_actor uuid\\)").includes("insert into sede_week_schedules (sede_id, week_start, team_key, created_by, updated_by)"));
});

test("migration 015: the segments wrappers forward the team to the base functions", () => {
  const pub = fn("shifts_publish_week", "p_sede text, p_week date, p_team text, p_expected_version int, p_actor uuid, p_segments jsonb");
  assert.ok(pub.includes("shifts_publish_week(p_sede, p_week, p_team, p_expected_version, p_actor)"));
  assert.ok(pub.includes("shifts_apply_segments"));
  const save = fn("shifts_save_week", "p_sede text, p_week date, p_team text, p_expected_version int, p_cedulas text\\[\\], p_shifts jsonb, p_actor uuid, p_segments jsonb");
  assert.ok(save.includes("shifts_save_week(p_sede, p_week, p_team, p_expected_version, p_cedulas, p_shifts, p_actor)"));
});

test("migration 015: cross-team guard raises SHIFT_IN_OTHER_TEAM before any write, under the cedula locks", () => {
  const body = fn("shifts_save_week", "p_sede text, p_week date, p_team text, p_expected_version int, p_cedulas text\\[\\], p_shifts jsonb, p_actor uuid\\)");
  const guard = body.indexOf("raise exception 'shift_in_other_team'");
  assert.ok(guard > 0);
  assert.ok(body.indexOf("'shifts:cedula:'") < guard, "cedula locks first");
  assert.ok(guard < body.indexOf("with p as ("), "guard before the writes");
  assert.ok(body.includes("'otherteamkey', o.team_key"));
  assert.ok(body.includes("o.sede_id = p_sede and o.week_start = p_week and o.id <> v_sch.id"));
});

test("migration 015: preserved behavior - history, overlap, paid-cut guard, version bump", () => {
  const save = fn("shifts_save_week", "p_sede text, p_week date, p_team text, p_expected_version int, p_cedulas text\\[\\], p_shifts jsonb, p_actor uuid\\)");
  assert.ok(save.includes("'editar_publicado'"));
  assert.ok(save.includes("raise exception 'shift_overlap'"));
  assert.ok(save.includes("version = v_new_version"));
  const unpub = fn("shifts_unpublish_week", "p_sede text, p_week date, p_team text, p_expected_version int, p_actor uuid\\)");
  assert.ok(unpub.includes("raise exception 'payroll_cut_paid'"));
  assert.ok(unpub.includes("'despublicar'"));
});

test("migration 015: new functions are service_role only", () => {
  for (const sig of [
    "shifts_save_week(text, date, text, int, text[], jsonb, uuid)",
    "shifts_save_week(text, date, text, int, text[], jsonb, uuid, jsonb)",
    "shifts_publish_week(text, date, text, int, uuid)",
    "shifts_publish_week(text, date, text, int, uuid, jsonb)",
    "shifts_unpublish_week(text, date, text, int, uuid)",
  ]) {
    assert.ok(sql.includes(`revoke all on function ${sig} from public`), sig);
    assert.ok(sql.includes(`revoke all on function ${sig} from anon, authenticated`), sig);
    assert.ok(sql.includes(`grant execute on function ${sig} to service_role`), sig);
  }
});

test("migration 015: rollback refuses with extra teams; verify ends in ROLLBACK", () => {
  const d = flat(read("migrations/rollback/015_schedule_teams.down.sql"));
  assert.ok(d.includes("rollback_refused"));
  assert.ok(d.includes("alter table sede_week_schedules drop column if exists team_key"));
  assert.ok(d.includes("alter table schedule_publish_snapshots drop column if exists team_key"));
  const v = flat(read("verification/015_schedule_teams_verify.sql")).trim();
  assert.match(v, /^begin;/);
  assert.match(v, /rollback;$/);
  assert.ok(v.includes("all checks passed"));
});
