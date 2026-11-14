import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { sanitizeShiftSegments, sanitizeSegmentsForShifts } = await import("../../src/modules/horarios/domain/segments.js");
const { publishBodySchema, saveBodySchema } = await import("../../src/modules/horarios/horarios.schemas.js");
const { createHorariosRepo } = await import("../../src/modules/horarios/horarios.supabase.js");
const { createHorariosService } = await import("../../src/modules/horarios/horarios.service.js");

// ------------------------------------------------------------------ migration 014 (static checks on the SQL files)

const read = (rel) => readFileSync(new URL(`../../db/${rel}`, import.meta.url), "utf8");
const flat = (s) => s.toLowerCase().replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

test("migration 014: nullable jsonb column guarded by a CHECK (array, TRABAJO only), idempotent", () => {
  const sql = flat(read("migrations/014_shift_segments.sql"));
  assert.ok(sql.includes("alter table shifts add column if not exists segments jsonb;"));
  assert.ok(sql.includes("jsonb_typeof(segments) = 'array' and tipo = 'trabajo'"));
  assert.ok(sql.includes("if not exists (select 1 from pg_constraint where conname = 'shifts_segments_chk'"));
  assert.ok(sql.includes("drop trigger if exists shifts_reset_stale_segments_trg on shifts"));
  assert.match(read("migrations/014_shift_segments.sql"), /apply this BEFORE deploying the backend/i);
});

test("migration 014: new overloads call the old functions, keep them callable and are service_role only", () => {
  const sql = flat(read("migrations/014_shift_segments.sql"));
  assert.ok(sql.includes("create or replace function shifts_publish_week( p_sede text, p_week date, p_expected_version int, p_actor uuid, p_segments jsonb)"));
  assert.ok(sql.includes("v_result := shifts_publish_week(p_sede, p_week, p_expected_version, p_actor);"));
  assert.ok(sql.includes("p_actor uuid, p_segments jsonb) returns jsonb"));
  assert.ok(sql.includes("v_result := shifts_save_week(p_sede, p_week, p_expected_version, p_cedulas, p_shifts, p_actor);"));
  assert.doesNotMatch(sql, /drop function/);
  for (const fn of ["shifts_publish_week(text, date, int, uuid, jsonb)", "shifts_save_week(text, date, int, text[], jsonb, uuid, jsonb)", "shifts_apply_segments(uuid, text[], jsonb)"]) {
    assert.ok(sql.includes(`revoke all on function ${fn} from anon, authenticated`), fn);
    assert.ok(sql.includes(`grant execute on function ${fn} to service_role`), fn);
  }
  // Unpublish clears the split; an edit that changes the shift resets it.
  assert.ok(sql.includes("old.state = 'publicado' and new.state = 'borrador'"));
  assert.ok(sql.includes("new.segments := null"));
});

test("migration 014: rollback keeps a copy before dropping; verify ends in ROLLBACK", () => {
  const d = flat(read("migrations/rollback/014_shift_segments.down.sql"));
  assert.ok(d.indexOf("shifts_segments_backup_014") < d.indexOf("alter table shifts drop column if exists segments"));
  const v = flat(read("verification/014_shift_segments_verify.sql")).trim();
  assert.match(v, /^begin;/);
  assert.match(v, /rollback;$/);
  assert.ok(v.includes("all checks passed"));
});

// ------------------------------------------------------------------ domain: sanitize

const shift = { cedula: "11111111", fecha: "2031-01-06", tipo: "TRABAJO", startTime: "08:00", endTime: "17:00" };
const seg = (role, from, to) => ({ role, from, to });

test("a split that fits the shift (with a lunch gap) is kept as sent", () => {
  const split = [seg("caja", "08:00", "12:00"), seg("surtido", "13:00", "17:00")];
  assert.deepEqual(sanitizeShiftSegments(shift, split), split);
});

test("segments outside the shift, overlapping, unordered, off the 15-minute grid or with a bad role are rejected (null)", () => {
  for (const split of [
    [seg("caja", "07:45", "12:00")],
    [seg("caja", "08:00", "17:15")],
    [seg("caja", "08:00", "12:00"), seg("surtido", "11:45", "17:00")],
    [seg("surtido", "13:00", "17:00"), seg("caja", "08:00", "12:00")],
    [seg("caja", "08:10", "12:00")],
    [seg("cocina", "08:00", "12:00")],
    [seg("caja", "12:00", "12:00")],
    [],
    null,
  ]) {
    assert.equal(sanitizeShiftSegments(shift, split), null, JSON.stringify(split));
  }
});

test("shifts that cross midnight or end at 24:00 are measured from their start", () => {
  const night = { ...shift, startTime: "18:00", endTime: "02:00" };
  assert.ok(sanitizeShiftSegments(night, [seg("caja", "18:00", "23:00"), seg("surtido", "23:00", "02:00")]));
  assert.equal(sanitizeShiftSegments(night, [seg("caja", "18:00", "03:00")]), null);
  const late = { ...shift, startTime: "16:00", endTime: "24:00" };
  assert.ok(sanitizeShiftSegments(late, [seg("surtido", "16:00", "24:00")]));
});

test("rest days and unknown shifts never keep segments; duplicates are dropped", () => {
  const rest = { cedula: "11111111", fecha: "2031-01-07", tipo: "DESCANSO", startTime: null, endTime: null };
  const split = [seg("caja", "08:00", "12:00")];
  const { items, dropped } = sanitizeSegmentsForShifts([shift, rest], [
    { cedula: "11111111", fecha: "2031-01-06", segments: split },
    { cedula: "11111111", fecha: "2031-01-06", segments: split },
    { cedula: "11111111", fecha: "2031-01-07", segments: split },
    { cedula: "22222222", fecha: "2031-01-06", segments: split },
  ]);
  assert.deepEqual(items, [{ cedula: "11111111", fecha: "2031-01-06", segments: split }]);
  assert.equal(dropped, 3);
});

// ------------------------------------------------------------------ schemas

const entry = (segments) => ({ cedula: "11111111", fecha: "2031-01-06", segments });

test("publish and save bodies accept optional segments and reject malformed ones", () => {
  const good = [entry([seg("caja", "08:00", "12:00"), seg("surtido", "12:00", "24:00")])];
  assert.equal(publishBodySchema.safeParse({ expectedVersion: 1, segments: good }).success, true);
  assert.equal(publishBodySchema.safeParse({ expectedVersion: 1, segments: null }).success, true);
  assert.equal(publishBodySchema.safeParse({ expectedVersion: 1 }).success, true);
  const save = { expectedVersion: 2, cedulas: ["11111111"], shifts: [] };
  assert.equal(saveBodySchema.safeParse({ ...save, segments: good }).success, true);
  for (const bad of [
    [entry([seg("cocina", "08:00", "12:00")])],
    [entry([seg("caja", "8:00", "12:00")])],
    [entry([seg("caja", "08:10", "12:00")])],
    [entry([seg("caja", "24:00", "12:00")])],
    [entry(Array.from({ length: 49 }, () => seg("caja", "08:00", "08:15")))],
    [{ cedula: "abc", fecha: "2031-01-06", segments: [] }],
    "basura",
  ]) {
    assert.equal(publishBodySchema.safeParse({ expectedVersion: 1, segments: bad }).success, false, JSON.stringify(bad));
    assert.equal(saveBodySchema.safeParse({ ...save, segments: bad }).success, false, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------------ repo: atomic RPC + fallback

const ACTOR = "22222222-2222-4222-8222-222222222222";
const base = { sedeId: "copacabana", weekStart: "2031-01-06", expectedVersion: 4, actor: ACTOR };
const split = [{ cedula: "11111111", fecha: "2031-01-06", segments: [seg("caja", "08:00", "17:00")] }];

function rpcClient(handler) {
  const calls = [];
  return { calls, rpc: async (name, args) => (calls.push([name, args]), handler(name, args, calls.length)) };
}

test("publishWeek with segments sends them in the same RPC and reports segmentsSaved", async () => {
  const client = rpcClient(() => ({ data: { id: "s", noop: false }, error: null }));
  const out = await createHorariosRepo(client).publishWeek({ ...base, segments: split });
  assert.deepEqual(client.calls, [["shifts_publish_week", { p_sede: "copacabana", p_week: "2031-01-06", p_expected_version: 4, p_actor: ACTOR, p_segments: split }]]);
  assert.equal(out.segmentsSaved, true);
  assert.equal(out.noop, false);
});

test("publishWeek without segments uses the previous signature untouched", async () => {
  const client = rpcClient(() => ({ data: { noop: false }, error: null }));
  const out = await createHorariosRepo(client).publishWeek(base);
  assert.equal("p_segments" in client.calls[0][1], false);
  assert.equal(out.segmentsSaved, false);
});

test("FALLBACK: when migration 014 is not applied the old publish runs, a warning is logged and publishing still succeeds", async () => {
  const warnings = [];
  const client = rpcClient((_n, args) =>
    "p_segments" in args ? { data: null, error: { code: "PGRST202", message: "Could not find the function" } } : { data: { id: "s", noop: false }, error: null });
  const out = await createHorariosRepo(client, { logger: { warn: (m) => warnings.push(m) } }).publishWeek({ ...base, segments: split });
  assert.equal(client.calls.length, 2);
  assert.equal("p_segments" in client.calls[1][1], false);
  assert.equal(out.segmentsSaved, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /migration 014/);
});

test("a business error from the new RPC is mapped, never swallowed by the fallback", async () => {
  const client = rpcClient(() => ({ data: null, error: { code: "P0001", message: "VERSION_CONFLICT", details: "6" } }));
  await assert.rejects(createHorariosRepo(client).publishWeek({ ...base, segments: split }), (e) => e.statusCode === 409 && e.details.currentVersion === 6);
  assert.equal(client.calls.length, 1);
});

test("saveWeek with segments uses the 7-argument RPC and falls back to the 6-argument one", async () => {
  const shifts = [{ cedula: "11111111", fecha: "2031-01-06", tipo: "TRABAJO", startTime: "08:00", endTime: "17:00", breakMinutes: 60 }];
  const args = { ...base, cedulas: ["11111111"], shifts };
  const ok = rpcClient(() => ({ data: { id: "s", version: 5 }, error: null }));
  const saved = await createHorariosRepo(ok).saveWeek({ ...args, segments: split });
  assert.deepEqual(ok.calls[0][1].p_segments, split);
  assert.equal(saved.version, 5);

  const old = rpcClient((_n, a) => ("p_segments" in a ? { data: null, error: { code: "42883", message: "function does not exist" } } : { data: { id: "s", version: 5 }, error: null }));
  const out = await createHorariosRepo(old, { logger: { warn() {} } }).saveWeek({ ...args, segments: split });
  assert.equal(old.calls.length, 2);
  assert.equal(out.version, 5);
});

// ------------------------------------------------------------------ service

const W = "2031-01-06";
const SCHED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLANNER = "22222222-2222-4222-8222-222222222222";
const planner = { role: "planner", sedeIds: ["copacabana"] };
const DAYS = ["06", "07", "08", "09", "10", "11"].map((d) => `2031-01-${d}`);
const dbRow = (fecha, tipo = "TRABAJO") => ({
  id: `r-${fecha}`, schedule_id: SCHED, sede_id: "copacabana", cedula: "11111111", fecha, tipo,
  start_time: tipo === "TRABAJO" ? "08:00:00" : null, end_time: tipo === "TRABAJO" ? "17:00:00" : null,
  break_minutes: tipo === "TRABAJO" ? 60 : 0, lunch_start: null, cargo: null, observacion: null,
});
const schedule = (over = {}) => ({
  id: SCHED, sede_id: "copacabana", week_start: W, state: "BORRADOR", version: 1, published_by: null, published_at: null,
  created_by: PLANNER, created_at: "t0", updated_by: PLANNER, updated_at: "t1", ...over,
});

function build({ sch = schedule(), rows = [...DAYS.map((d) => dbRow(d)), dbRow("2031-01-12", "DESCANSO")] } = {}) {
  const calls = [];
  const warnings = [];
  const repo = {
    async findSede(id) { return { sede_id: id }; },
    async findSchedule() { return sch; },
    async findPaidCutOverlapping() { return null; },
    async listShifts() { return rows; },
    async listShiftsByCedulas() { return []; },
    async saveWeek(args) { calls.push(["saveWeek", args]); return { id: SCHED }; },
    async publishWeek(args) { calls.push(["publishWeek", args]); sch = { ...sch, state: "PUBLICADO", version: sch.version + 1, published_by: PLANNER, published_at: "t3" }; return { noop: false, segmentsSaved: Boolean(args.segments) }; },
  };
  const service = createHorariosService({ repo, profilesRepo: { async findById() { return null; } }, logger: { warn: (...a) => warnings.push(a), error() {} } });
  return { service, calls, warnings };
}

test("publish passes only the segments that fit the stored shifts to the RPC (atomic) and warns about the rest", async () => {
  const { service, calls, warnings } = build();
  const good = { cedula: "11111111", fecha: DAYS[0], segments: [seg("caja", "08:00", "12:00"), seg("surtido", "13:00", "17:00")] };
  const outside = { cedula: "11111111", fecha: DAYS[1], segments: [seg("caja", "06:00", "12:00")] };
  const restDay = { cedula: "11111111", fecha: "2031-01-12", segments: [seg("caja", "08:00", "12:00")] };
  const out = await service.publish(planner, { id: PLANNER }, "copacabana", W, { expectedVersion: 1, segments: [good, outside, restDay] });
  assert.deepEqual(calls[0][1].segments, [good]);
  assert.equal(out.segmentsSaved, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1].dropped, 2);
});

test("publish without segments keeps the previous behaviour (segments null, segmentsSaved false)", async () => {
  const { service, calls } = build();
  const out = await service.publish(planner, { id: PLANNER }, "copacabana", W, { expectedVersion: 1 });
  assert.equal(calls[0][1].segments, null);
  assert.equal(out.segmentsSaved, false);
});

test("save of a PUBLICADO week refreshes the segments against the NEW shifts; a draft ignores them", async () => {
  const shifts = [{ cedula: "11111111", fecha: W, tipo: "TRABAJO", startTime: "08:00", endTime: "16:00", breakMinutes: 60 }];
  const body = {
    expectedVersion: 2, cedulas: ["11111111"], shifts,
    segments: [
      { cedula: "11111111", fecha: W, segments: [seg("surtido", "08:00", "16:00")] },
      { cedula: "11111111", fecha: W, segments: [seg("surtido", "08:00", "17:00")] }, // does not fit the new end time
    ],
  };
  const published = build({ sch: schedule({ state: "PUBLICADO", version: 2, published_by: PLANNER, published_at: "t3" }) });
  await published.service.save(planner, { id: PLANNER }, "copacabana", W, body);
  assert.deepEqual(published.calls[0][1].segments, [{ cedula: "11111111", fecha: W, segments: [seg("surtido", "08:00", "16:00")] }]);

  const draft = build({ sch: schedule({ version: 2 }) });
  await draft.service.save(planner, { id: PLANNER }, "copacabana", W, body);
  assert.equal(draft.calls[0][1].segments, null);

  const noSegments = build({ sch: schedule({ state: "PUBLICADO", version: 2, published_by: PLANNER, published_at: "t3" }) });
  await noSegments.service.save(planner, { id: PLANNER }, "copacabana", W, { ...body, segments: undefined });
  assert.equal(noSegments.calls[0][1].segments, null);
});
