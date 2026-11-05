import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static checks only: the migration is applied manually and never run by tests.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const sql = read("../../db/migrations/004_shifts.sql");
const down = read("../../db/migrations/rollback/004_shifts.down.sql");
const seed = read("../../db/seeds/sugerido_sedes.sql");
const squash = (s) => s.toLowerCase().replace(/\s+/g, " ");
const code = (s) => squash(s.replace(/--[^\n]*/g, ""));
const norm = squash(sql);

const SAVE_SIG = "shifts_save_week(text, date, int, text[], jsonb, uuid)";
const PUBLISH_SIG = "shifts_publish_week(text, date, int, uuid)";
const TABLES = ["sede_week_schedules", "shifts", "shift_history"];
const CODES = [
  ["copacabana", "001"], ["villahermosa", "002"], ["girardota-parque", "003"], ["girardota-llano", "004"],
  ["barbosa", "006"], ["las-vegas", "007"], ["san-juan", "008"],
];

// Text of a `create or replace function <name>(...)` up to its closing `$$;`.
function fnBody(name) {
  const m = new RegExp(`create or replace function ${name}\\(([\\s\\S]*?)\\$\\$;`, "i").exec(sql);
  assert.ok(m, `function ${name} not found`);
  return squash(m[0]);
}

test("sugerido_sedes gets a validated, unique, idempotently seeded siesa_code", () => {
  assert.match(norm, /alter table sugerido_sedes add column if not exists siesa_code text check \(siesa_code ~ '\^\[0-9\]\{3,4\}\$'\)/);
  assert.match(
    norm,
    /create unique index if not exists sugerido_sedes_siesa_code_key on sugerido_sedes \(siesa_code\) where siesa_code is not null/,
  );
  for (const [sede, c] of CODES) {
    assert.ok(norm.includes(`('${sede}','${c}')`) || norm.includes(`('${sede}', '${c}')`), `${sede}=${c}`);
  }
  assert.match(norm, /where s\.sede_id = v\.sede and s\.siesa_code is null/);
});

test("the three tables are RLS-protected, closed to anon/authenticated and have no policies", () => {
  for (const t of TABLES) {
    assert.ok(norm.includes(`create table if not exists ${t} (`), t);
    assert.ok(norm.includes(`alter table ${t} enable row level security`), t);
    assert.ok(norm.includes(`revoke all on table ${t} from anon, authenticated`), t);
  }
  assert.doesNotMatch(norm, /create policy/);
});

test("schedule table: Monday check, state enum, publish consistency, unique keys", () => {
  assert.match(norm, /check \(extract\(isodow from week_start\) = 1\)/);
  assert.match(norm, /state in \('borrador','publicado'\)/);
  assert.match(norm, /unique \(sede_id, week_start\)/);
  assert.match(norm, /unique \(id, sede_id\)/);
  assert.match(norm, /constraint sws_publish_chk check/);
  assert.match(norm, /version int not null default 0 check \(version >= 0\)/);
});

test("shifts table: natural key, kind check, break check, snapshot column", () => {
  assert.match(norm, /unique \(schedule_id, cedula, fecha\)/);
  assert.match(norm, /foreign key \(schedule_id, sede_id\) references sede_week_schedules \(id, sede_id\)/);
  assert.match(norm, /cedula text not null check \(cedula ~ '\^\[0-9\]\{5,15\}\$'\)/);
  assert.match(norm, /tipo in \('trabajo','descanso','compensatorio'\)/);
  assert.match(norm, /break_minutes int not null default 0 check \(break_minutes between 0 and 480\)/);
  assert.match(norm, /constraint shifts_kind_chk check/);
  assert.match(norm, /constraint shifts_break_fits_chk check/);
  assert.match(norm, /siesa_code text,/);
  assert.match(norm, /create index if not exists shifts_cedula_fecha_idx on shifts \(cedula, fecha\)/);
});

test("history: one row per changed shift, PUBLICAR row, shape check, no FK on shift_id", () => {
  assert.match(norm, /action in \('crear','editar','eliminar','editar_publicado','publicar'\)/);
  assert.match(norm, /constraint sh_shape_chk check/);
  assert.match(norm, /shift_id uuid,/);
  assert.match(norm, /create index if not exists shift_history_schedule_idx on shift_history \(schedule_id, at desc, id desc\)/);
  const shape = norm.slice(norm.indexOf("constraint sh_shape_chk"));
  assert.match(shape, /action = 'publicar' and shift_id is null and cedula is null and fecha is null and before is null and after is not null/);
  assert.match(shape, /action = 'eliminar' and shift_id is not null and before is not null and after is null/);
});

test("RPCs are security invoker, take the week lock and sorted cedula locks", () => {
  for (const fn of ["shifts_save_week", "shifts_publish_week"]) {
    const body = fnBody(fn);
    assert.match(body, /security invoker/);
    assert.match(body, /pg_advisory_xact_lock\(hashtext\('shifts:week:' ?\|\| ?p_sede ?\|\| ?':' ?\|\| ?to_char\(p_week, ?'yyyy-mm-dd'\)\)\)/);
    assert.match(body, /for update/);
    assert.match(body, /version_conflict/);
  }
  const save = fnBody("shifts_save_week");
  assert.match(save, /hashtext\('shifts:cedula:' ?\|\| ?c\)/);
  assert.match(save, /order by 1/);
  assert.match(save, /invalid_shifts/);
  assert.match(save, /shift_overlap/);
  assert.match(save, /coalesce\(p_expected_version, 0\)/);
  assert.match(save, /editar_publicado/);
  assert.match(save, /is distinct from/);
  const pub = fnBody("shifts_publish_week");
  assert.match(pub, /schedule_not_found/);
  assert.match(pub, /noop/);
  assert.match(pub, /'publicar'/);
});

test("functions are defined BEFORE the revoke/grant block; only service_role may execute them", () => {
  const c = code(sql);
  const lastFn = c.lastIndexOf("create or replace function");
  const firstRevoke = c.indexOf("revoke all on function");
  assert.ok(lastFn >= 0 && firstRevoke > lastFn, "revoke/grant must come after both function definitions");
  for (const sig of [SAVE_SIG, PUBLISH_SIG]) {
    assert.ok(norm.includes(`revoke all on function ${sig} from public`), sig);
    assert.ok(norm.includes(`revoke all on function ${sig} from anon, authenticated`), sig);
    assert.ok(norm.includes(`grant execute on function ${sig} to service_role`), sig);
  }
});

test("header documents apply order and the rollback script", () => {
  const header = sql.slice(0, sql.indexOf("alter table sugerido_sedes"));
  assert.match(header, /AFTER 001, 002 and 003/);
  assert.match(header, /ROLLBACK/);
  assert.match(header, /004_shifts\.down\.sql/);
});

test("down script drops the functions by exact signature, the tables, the index and the column", () => {
  const d = code(down);
  assert.ok(d.includes(`drop function if exists ${PUBLISH_SIG}`));
  assert.ok(d.includes(`drop function if exists ${SAVE_SIG}`));
  for (const t of TABLES) assert.ok(d.includes(`drop table if exists ${t}`), t);
  assert.ok(d.includes("drop index if exists sugerido_sedes_siesa_code_key"));
  assert.ok(d.includes("alter table sugerido_sedes drop column if exists siesa_code"));
  assert.ok(d.indexOf("drop function") < d.indexOf("drop table"), "functions go before tables");
});

test("seed carries siesa_code, updates it on conflict and says it runs after 004", () => {
  const s = squash(seed);
  assert.match(s, /after 001\.\.004/);
  assert.match(s, /insert into sugerido_sedes \(sede_id, nombre, bodegas, trazabilidad_aliases, siesa_code, activo\)/);
  assert.match(s, /siesa_code = excluded\.siesa_code/);
  assert.match(s, /select sede_id, nombre, siesa_code, bodegas, trazabilidad_aliases from sugerido_sedes/);
  for (const [sede, c] of CODES) {
    assert.match(s, new RegExp(`\\('${sede}', +'[^']+', +array\\[[^\\]]*\\], +array\\[[^\\]]*\\], +'${c}', +true\\)`), sede);
  }
});
