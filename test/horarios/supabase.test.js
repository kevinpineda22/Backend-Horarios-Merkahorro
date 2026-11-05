import test from "node:test";
import assert from "node:assert/strict";

const { createHorariosRepo } = await import("../../src/modules/horarios/horarios.supabase.js");

const ACTOR = "22222222-2222-4222-8222-222222222222";
const SCHED = "33333333-3333-4333-8333-333333333333";

function fake(result = { data: [], error: null }) {
  const log = [];
  const builder = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res, rej) => Promise.resolve(result).then(res, rej);
      return (...args) => (log.push([prop, ...args]), builder);
    },
  });
  return { log, client: { from: (t) => (log.push(["from", t]), builder), rpc: (n, a) => (log.push(["rpc", n, a]), Promise.resolve(result)) } };
}
const has = (log, ...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));
const rejects = (p, status, code, check) =>
  assert.rejects(p, (e) => {
    assert.equal(e.statusCode, status);
    assert.equal(e.code, code);
    assert.equal(e.expose, true);
    check?.(e);
    return true;
  });

const shift = {
  cedula: "11111111", fecha: "2031-01-06", tipo: "TRABAJO", startTime: "08:00", endTime: "17:00",
  breakMinutes: 60, lunchStart: "12:00", cargo: "Cajero", observacion: null,
};
const save = (client, over = {}) =>
  createHorariosRepo(client).saveWeek({
    sedeId: "copacabana", weekStart: "2031-01-06", expectedVersion: 2, cedulas: ["11111111"], shifts: [shift], actor: ACTOR, ...over,
  });

test("saveWeek maps camelCase to the snake_case the RPC reads and uses the exact parameter names", async () => {
  const { log, client } = fake({ data: { id: SCHED, version: 3 }, error: null });
  const out = await save(client);
  assert.deepEqual(
    log.find((c) => c[0] === "rpc"),
    ["rpc", "shifts_save_week", {
      p_sede: "copacabana", p_week: "2031-01-06", p_expected_version: 2, p_cedulas: ["11111111"], p_actor: ACTOR,
      p_shifts: [{
        cedula: "11111111", fecha: "2031-01-06", tipo: "TRABAJO", start_time: "08:00", end_time: "17:00",
        break_minutes: 60, lunch_start: "12:00", cargo: "Cajero", observacion: null,
      }],
    }],
  );
  assert.equal(out.version, 3);
});

test("a null expectedVersion is sent as 0", async () => {
  const { log, client } = fake({ data: {}, error: null });
  await save(client, { expectedVersion: null });
  assert.equal(log.find((c) => c[0] === "rpc")[2].p_expected_version, 0);
});

test("publishWeek calls its RPC with the exact parameter names", async () => {
  const { log, client } = fake({ data: { noop: false }, error: null });
  await createHorariosRepo(client).publishWeek({ sedeId: "copacabana", weekStart: "2031-01-06", expectedVersion: 4, actor: ACTOR });
  assert.ok(has(log, "rpc", "shifts_publish_week", { p_sede: "copacabana", p_week: "2031-01-06", p_expected_version: 4, p_actor: ACTOR }));
});

test("RPC exceptions map to HTTP errors with details", async () => {
  const run = (error) => save(fake({ data: null, error }).client);
  await rejects(run({ message: "VERSION_CONFLICT", details: "7", code: "P0001" }), 409, "VERSION_CONFLICT", (e) =>
    assert.deepEqual(e.details, { currentVersion: 7 }));
  await rejects(run({ message: "VERSION_CONFLICT", details: "0", code: "P0001" }), 409, "VERSION_CONFLICT", (e) =>
    assert.deepEqual(e.details, { currentVersion: 0 }));
  const conflicts = [{ cedula: "11111111", fecha: "2031-01-06", otherSedeId: "las-vegas" }];
  await rejects(run({ message: "SHIFT_OVERLAP", details: JSON.stringify(conflicts), code: "P0001" }), 422, "SHIFT_OVERLAP", (e) =>
    assert.deepEqual(e.details, { conflicts }));
  await rejects(run({ message: "SCHEDULE_NOT_FOUND", code: "P0001" }), 404, "SCHEDULE_NOT_FOUND");
  await rejects(run({ message: "INVALID_SHIFTS", code: "P0001" }), 400, "INVALID_SHIFTS");
  await rejects(run({ message: "insert violates foreign key", code: "23503" }), 404, "SEDE_NOT_FOUND");
});

test("an unreadable conflict detail still yields a 422 with an empty list", async () => {
  await rejects(save(fake({ data: null, error: { message: "SHIFT_OVERLAP", details: "not json", code: "P0001" } }).client), 422, "SHIFT_OVERLAP", (e) =>
    assert.deepEqual(e.details, { conflicts: [] }));
});

test("unknown database errors are rethrown untouched", async () => {
  await assert.rejects(save(fake({ data: null, error: { message: "boom", code: "XX000" } }).client), (e) => e.message === "boom" && !e.expose);
});

test("findSede and findSchedule read the right tables", async () => {
  const { log, client } = fake({ data: { sede_id: "copacabana" }, error: null });
  const repo = createHorariosRepo(client);
  const sede = await repo.findSede("copacabana");
  assert.equal(sede.sede_id, "copacabana");
  assert.ok(has(log, "from", "sugerido_sedes"));
  assert.ok(has(log, "eq", "sede_id", "copacabana"));
  await repo.findSchedule("copacabana", "2031-01-06");
  assert.ok(has(log, "from", "sede_week_schedules"));
  assert.ok(has(log, "eq", "week_start", "2031-01-06"));
});

test("listShiftsByCedulas filters by cedulas and dates and can exclude a schedule", async () => {
  const { log, client } = fake({ data: [], error: null });
  await createHorariosRepo(client).listShiftsByCedulas({ cedulas: ["1"], from: "2031-01-05", to: "2031-01-13", excludeScheduleId: SCHED });
  assert.ok(has(log, "from", "shifts"));
  assert.ok(has(log, "in", "cedula", ["1"]));
  assert.ok(has(log, "gte", "fecha", "2031-01-05"));
  assert.ok(has(log, "lte", "fecha", "2031-01-13"));
  assert.ok(has(log, "neq", "schedule_id", SCHED));
  const { log: l2, client: c2 } = fake({ data: [], error: null });
  await createHorariosRepo(c2).listShiftsByCedulas({ cedulas: ["1"], from: "a", to: "b" });
  assert.ok(!l2.some((c) => c[0] === "neq"));
});

test("listShiftsByCedulas with no cedulas never queries", async () => {
  const { log, client } = fake();
  assert.deepEqual(await createHorariosRepo(client).listShiftsByCedulas({ cedulas: [], from: "a", to: "b" }), []);
  assert.equal(log.length, 0);
});

test("listHistory orders newest first and applies the limit", async () => {
  const { log, client } = fake({ data: [], error: null });
  await createHorariosRepo(client).listHistory({ scheduleId: SCHED, limit: 50 });
  assert.ok(has(log, "from", "shift_history"));
  assert.ok(has(log, "eq", "schedule_id", SCHED));
  assert.ok(has(log, "limit", 50));
  assert.ok(log.some((c) => c[0] === "order" && c[1] === "at" && c[2].ascending === false));
});

test("read errors are rethrown", async () => {
  const boom = new Error("db down");
  await assert.rejects(createHorariosRepo(fake({ data: null, error: boom }).client).findSchedule("a", "b"), boom);
});

// Paging fake: serves `total` rows, honouring the last .range(from, to) call (PostgREST caps pages at 1000).
function pagedFake(total) {
  const log = [];
  const all = Array.from({ length: total }, (_, i) => ({ id: i }));
  let range = null;
  const builder = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (res, rej) => {
          const [from, to] = range ?? [0, total - 1];
          return Promise.resolve({ data: all.slice(from, Math.min(to, from + 999) + 1), error: null }).then(res, rej);
        };
      }
      return (...args) => {
        if (prop === "range") range = args;
        log.push([prop, ...args]);
        return builder;
      };
    },
  });
  return { log, client: { from: () => builder } };
}

test("listShifts pages with .range until a short page so no week is truncated", async () => {
  const { log, client } = pagedFake(2100);
  const rows = await createHorariosRepo(client).listShifts(SCHED);
  assert.equal(rows.length, 2100);
  assert.deepEqual(log.filter((c) => c[0] === "range"), [["range", 0, 999], ["range", 1000, 1999], ["range", 2000, 2999]]);
});

test("listShifts asks for one more page when the last page is exactly full", async () => {
  const { log, client } = pagedFake(1000);
  const rows = await createHorariosRepo(client).listShifts(SCHED);
  assert.equal(rows.length, 1000);
  assert.equal(log.filter((c) => c[0] === "range").length, 2);
});

test("listShiftsByCedulas pages too", async () => {
  const { log, client } = pagedFake(1500);
  const rows = await createHorariosRepo(client).listShiftsByCedulas({ cedulas: ["11111111"], from: "2031-01-05", to: "2031-01-13" });
  assert.equal(rows.length, 1500);
  assert.deepEqual(log.filter((c) => c[0] === "range"), [["range", 0, 999], ["range", 1000, 1999]]);
});
