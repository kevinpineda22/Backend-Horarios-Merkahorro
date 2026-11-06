import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static checks only: the migration is applied manually and never run by tests.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const sql = read("../../db/migrations/005_payroll_cuts.sql");
const down = read("../../db/migrations/rollback/005_payroll_cuts.down.sql");
const verify = read("../../db/verification/005_payroll_cuts_verify.sql");
const squash = (s) => s.toLowerCase().replace(/\s+/g, " ");
const code = (s) => squash(s.replace(/--[^\n]*/g, ""));
const norm = squash(sql);

const SAVE_SIG = "payroll_cut_save(date, date, jsonb, uuid)";
const VOID_SIG = "payroll_cut_void(bigint, text, uuid)";
const TABLES = ["payroll_cuts", "payroll_cut_lines", "payroll_cut_weeks", "payroll_cut_history"];

// Text of a `create or replace function <name>(...)` up to its closing `$$;`.
function fnBody(name) {
  const m = new RegExp(`create or replace function ${name}\\(([\\s\\S]*?)\\$\\$;`, "i").exec(sql);
  assert.ok(m, `function ${name} not found`);
  return squash(m[0]);
}

test("the four tables are RLS-protected, closed to anon/authenticated and have no policies", () => {
  for (const t of TABLES) {
    assert.ok(norm.includes(`create table if not exists ${t} (`), t);
    assert.ok(norm.includes(`alter table ${t} enable row level security`), t);
    assert.ok(norm.includes(`revoke all on table ${t} from anon, authenticated`), t);
  }
  assert.doesNotMatch(norm, /create policy/);
});

test("PAGADO cuts cannot overlap: a partial EXCLUDE on the date range, no btree_gist needed", () => {
  assert.match(
    norm,
    /constraint payroll_cuts_paid_no_overlap exclude using gist \(daterange\(period_start, period_end, '\[\]'\) with &&\) where \(state = 'pagado'\)/,
  );
  assert.doesNotMatch(code(sql), /btree_gist/);
});

test("cut table: Monday/Sunday checks, 7 or 14 days, state enum, void consistency", () => {
  assert.match(norm, /period_start date not null check \(extract\(isodow from period_start\) = 1\)/);
  assert.match(norm, /period_end date not null check \(extract\(isodow from period_end\) = 7\)/);
  assert.match(norm, /constraint pc_len_chk check \(period_end - period_start in \(6, 13\)\)/);
  assert.match(norm, /state text not null default 'pagado' check \(state in \('pagado','anulado'\)\)/);
  assert.match(norm, /constraint pc_void_chk check/);
  assert.match(norm, /void_reason text check \(char_length\(void_reason\) <= 500\)/);
  assert.match(norm, /engine_version text not null/);
  assert.match(norm, /sundays jsonb not null/);
  assert.match(norm, /holidays jsonb not null/);
});

test("lines snapshot every employee incl. zero-hour, with siesa_code and branch_source", () => {
  assert.match(norm, /primary key \(cut_id, cedula\)/);
  assert.match(norm, /siesa_code text check \(siesa_code ~ '\^\[0-9\]\{3,4\}\$'\)/);
  assert.match(norm, /branch_source text check \(branch_source in \('shift','sede','directory'\)\)/);
  assert.match(norm, /in_directory boolean/);
  assert.match(norm, /worked_hours numeric\(8,2\) not null check \(worked_hours >= 0\)/);
  assert.match(norm, /create index if not exists payroll_cut_lines_sede_idx on payroll_cut_lines \(sede_id, cut_id\)/);
  assert.match(norm, /foreign key \(cut_id, cedula\) references payroll_cut_lines \(cut_id, cedula\)/);
  assert.match(norm, /primary key \(cut_id, cedula, week_start\)/);
});

test("history rows are CREAR / ANULAR", () => {
  assert.match(norm, /action in \('crear','anular'\)/);
});

test("RPCs are security invoker and take the global cuts lock", () => {
  for (const fn of ["payroll_cut_save", "payroll_cut_void"]) {
    const body = fnBody(fn);
    assert.match(body, /security invoker/);
    assert.match(body, /pg_advisory_xact_lock\(hashtext\('payroll:cuts'\)\)/);
  }
  const save = fnBody("payroll_cut_save");
  assert.match(save, /payroll_cut_overlap/);
  assert.match(save, /invalid_snapshot/);
  assert.match(save, /exclusion_violation/);
  assert.match(save, /'crear'/);
  assert.match(save, /jsonb_to_recordset/);
  assert.match(save, /count\(\*\)/); // employees = count(lines), zero-hour included
  const voidFn = fnBody("payroll_cut_void");
  assert.match(voidFn, /for update/);
  assert.match(voidFn, /payroll_cut_not_found/);
  assert.match(voidFn, /payroll_cut_already_void/);
  assert.match(voidFn, /'anular'/);
});

test("functions are defined BEFORE the revoke/grant block; only service_role may execute them", () => {
  const c = code(sql);
  const lastFn = c.lastIndexOf("create or replace function");
  const firstRevoke = c.indexOf("revoke all on function");
  assert.ok(lastFn >= 0 && firstRevoke > lastFn, "revoke/grant must come after both function definitions");
  for (const sig of [SAVE_SIG, VOID_SIG]) {
    assert.ok(norm.includes(`revoke all on function ${sig} from public`), sig);
    assert.ok(norm.includes(`revoke all on function ${sig} from anon, authenticated`), sig);
    assert.ok(norm.includes(`grant execute on function ${sig} to service_role`), sig);
  }
});

test("header documents apply order, the error contract and the rollback script", () => {
  const header = sql.slice(0, sql.indexOf("create table if not exists payroll_cuts"));
  assert.match(header, /AFTER 004/);
  assert.match(header, /ROLLBACK/);
  assert.match(header, /005_payroll_cuts\.down\.sql/);
  for (const token of ["PAYROLL_CUT_OVERLAP", "PAYROLL_CUT_NOT_FOUND", "PAYROLL_CUT_ALREADY_VOID", "INVALID_SNAPSHOT"]) {
    assert.ok(header.includes(token), token);
  }
});

test("down script drops the functions by exact signature, then the tables children first", () => {
  const d = code(down);
  assert.ok(d.includes(`drop function if exists ${SAVE_SIG}`));
  assert.ok(d.includes(`drop function if exists ${VOID_SIG}`));
  const order = ["payroll_cut_history", "payroll_cut_weeks", "payroll_cut_lines", "payroll_cuts"].map((t) =>
    d.indexOf(`drop table if exists ${t}`),
  );
  assert.ok(order.every((i) => i >= 0), "every table is dropped");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "children before parents");
  assert.ok(d.indexOf("drop function") < d.indexOf("drop table"), "functions go before tables");
});

test("verification script is rolled back, uses far-future dates and covers the contract", () => {
  const v = code(verify);
  assert.ok(v.trimEnd().endsWith("rollback;"), "must end with ROLLBACK");
  assert.match(v, /begin;/);
  assert.match(v, /2031-/);
  for (const needle of [
    "23p01", // exclusion backstop
    "payroll_cut_overlap",
    "payroll_cut_already_void",
    "invalid_snapshot",
    "has_function_privilege",
    "relrowsecurity",
  ]) {
    assert.ok(v.includes(needle), needle);
  }
});

test("overlap backstop yields details.cut = null when no PAGADO row is found", () => {
  assert.ok(!/coalesce\(\s*jsonb_build_object/.test(sql), "no unreachable coalesce around jsonb_build_object");
  assert.match(sql, /when v_conflict\.id is null then 'null'/);
});
