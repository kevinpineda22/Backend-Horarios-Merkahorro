import test from "node:test";
import assert from "node:assert/strict";

const { createPayrollRepo } = await import("../../src/modules/horarios/payroll.supabase.js");

// Awaiting the builder yields the next scripted result (or `rows` served through .range);
// rpc() resolves the scripted rpc result. Everything is recorded.
function cutsFake({ results = [], rpcResult = { data: null, error: null } } = {}) {
  const log = [];
  const queue = [...results];
  let range = null;
  const builder = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (res, rej) => {
          let next;
          if (range && Array.isArray(queue[0]?.rows)) {
            next = { data: queue.shift().rows.slice(range[0], range[1] + 1), error: null };
            range = null;
          } else {
            range = null;
            next = queue.shift() ?? { data: null, error: null };
          }
          return Promise.resolve(next).then(res, rej);
        };
      }
      return (...args) => {
        if (prop === "range") range = args;
        log.push([prop, ...args]);
        return builder;
      };
    },
  });
  return {
    log,
    client: {
      from: (t) => (log.push(["from", t]), builder),
      rpc: async (name, args) => (log.push(["rpc", name, args]), rpcResult),
    },
  };
}
const has = (log, ...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));

const CUT_ROW = {
  id: 7, period_start: "2026-08-31", period_end: "2026-09-13", state: "PAGADO", employees: 2,
  extras: 4, nocturnas: 2, dominicales: 6, festivos: 0, sundays: ["2026-09-06"], holidays: [],
  engine_version: "1", created_by: "u1", created_at: "2026-09-14T10:00:00Z",
  voided_by: null, voided_at: null, void_reason: null,
};

test("saveCut calls payroll_cut_save with the period, the snapshot and the actor and returns the cut row", async () => {
  const { log, client } = cutsFake({ rpcResult: { data: CUT_ROW, error: null } });
  const snapshot = { lines: [] };
  const out = await createPayrollRepo(client).saveCut({ from: "2026-08-31", to: "2026-09-13", snapshot, actor: "u1" });
  assert.equal(out, CUT_ROW);
  assert.deepEqual(log[0], ["rpc", "payroll_cut_save", { p_from: "2026-08-31", p_to: "2026-09-13", p_snapshot: snapshot, p_actor: "u1" }]);
});

test("voidCut calls payroll_cut_void; a missing reason travels as null", async () => {
  const { log, client } = cutsFake({ rpcResult: { data: CUT_ROW, error: null } });
  await createPayrollRepo(client).voidCut({ id: 7, actor: "u1" });
  assert.deepEqual(log[0], ["rpc", "payroll_cut_void", { p_id: 7, p_reason: null, p_actor: "u1" }]);
  await createPayrollRepo(client).voidCut({ id: 7, reason: "typo", actor: "u1" });
  assert.equal(log[1][2].p_reason, "typo");
});

test("RPC errors map to stable HTTP errors", async () => {
  const run = (error, op = "saveCut") =>
    createPayrollRepo(cutsFake({ rpcResult: { data: null, error } }).client)[op]({ id: 1, from: "a", to: "b", snapshot: {}, actor: "u" });
  const failure = async (error, op) => {
    try {
      await run(error, op);
    } catch (e) {
      return e;
    }
    throw new Error("should have rejected");
  };

  const overlap = await failure({ message: "PAYROLL_CUT_OVERLAP", details: '{"id":3,"from":"2026-08-31","to":"2026-09-13"}' });
  assert.deepEqual([overlap.statusCode, overlap.code], [409, "PAYROLL_CUT_OVERLAP"]);
  assert.deepEqual(overlap.details, { cut: { id: 3, from: "2026-08-31", to: "2026-09-13" } });

  const backstop = await failure({ code: "23P01", message: "conflicting key value violates exclusion constraint" });
  assert.deepEqual([backstop.statusCode, backstop.code, backstop.details], [409, "PAYROLL_CUT_OVERLAP", { cut: null }]);

  const invalid = await failure({ message: "INVALID_SNAPSHOT" });
  assert.deepEqual([invalid.statusCode, invalid.code], [400, "INVALID_SNAPSHOT"]);
  const check = await failure({ code: "23514", message: "violates check constraint" });
  assert.deepEqual([check.statusCode, check.code], [400, "INVALID_SNAPSHOT"]);

  const missing = await failure({ message: "PAYROLL_CUT_NOT_FOUND" }, "voidCut");
  assert.deepEqual([missing.statusCode, missing.code], [404, "PAYROLL_CUT_NOT_FOUND"]);
  const already = await failure({ message: "PAYROLL_CUT_ALREADY_VOID" }, "voidCut");
  assert.deepEqual([already.statusCode, already.code], [409, "PAYROLL_CUT_ALREADY_VOID"]);

  const boom = { message: "connection reset" };
  await assert.rejects(run(boom), (e) => e === boom);
});

test("listCuts reads history newest first, including ANULADO, with a limit", async () => {
  const { log, client } = cutsFake({ results: [{ data: [CUT_ROW], error: null }] });
  const rows = await createPayrollRepo(client).listCuts({ limit: 40 });
  assert.deepEqual(rows, [CUT_ROW]);
  assert.ok(has(log, "from", "payroll_cuts"));
  assert.ok(has(log, "order", "period_start", { ascending: false }));
  assert.ok(has(log, "order", "id", { ascending: false }));
  assert.ok(has(log, "limit", 40));
  assert.equal(log.some((c) => c[0] === "eq" && c[1] === "state"), false, "no state filter");
});

test("getCut returns the cut with its lines and weeks (paged), or null when it does not exist", async () => {
  const line = { cut_id: 7, cedula: "11111111" };
  const week = { cut_id: 7, cedula: "11111111", week_start: "2026-08-31" };
  const { log, client } = cutsFake({
    results: [{ data: CUT_ROW, error: null }, { data: [line], error: null }, { data: [week], error: null }],
  });
  const out = await createPayrollRepo(client).getCut(7);
  assert.deepEqual(out, { cut: CUT_ROW, lines: [line], weeks: [week] });
  assert.ok(has(log, "from", "payroll_cut_lines"));
  assert.ok(has(log, "from", "payroll_cut_weeks"));
  assert.equal(log.filter((c) => c[0] === "eq" && c[1] === "cut_id" && c[2] === 7).length, 2, "lines and weeks filter by cut");
  assert.equal(log.filter((c) => c[0] === "range").length, 2, "lines and weeks go through fetchAll");

  const none = cutsFake({ results: [{ data: null, error: null }] });
  assert.equal(await createPayrollRepo(none.client).getCut(99), null);
  assert.equal(none.log.some((c) => c[0] === "from" && c[1] === "payroll_cut_lines"), false, "no child reads");
});

test("findPaidCutOverlapping returns {id, from, to} of a PAGADO cut touching the period, else null", async () => {
  const { log, client } = cutsFake({ results: [{ data: CUT_ROW, error: null }] });
  const out = await createPayrollRepo(client).findPaidCutOverlapping("2026-09-07", "2026-09-20");
  assert.deepEqual(out, { id: 7, from: "2026-08-31", to: "2026-09-13" });
  assert.ok(has(log, "eq", "state", "PAGADO"));
  assert.ok(has(log, "lte", "period_start", "2026-09-20"));
  assert.ok(has(log, "gte", "period_end", "2026-09-07"));
  const none = cutsFake({ results: [{ data: null, error: null }] });
  assert.equal(await createPayrollRepo(none.client).findPaidCutOverlapping("a", "b"), null);
});

test("findLastPaidCut returns the PAGADO cut with the latest end, else null", async () => {
  const { log, client } = cutsFake({ results: [{ data: CUT_ROW, error: null }] });
  assert.deepEqual(await createPayrollRepo(client).findLastPaidCut(), { id: 7, from: "2026-08-31", to: "2026-09-13" });
  assert.ok(has(log, "eq", "state", "PAGADO"));
  assert.ok(has(log, "order", "period_end", { ascending: false }));
  const none = cutsFake({ results: [{ data: null, error: null }] });
  assert.equal(await createPayrollRepo(none.client).findLastPaidCut(), null);
});

test("sumCutLines totals the lines of the given sedes per cut", async () => {
  const rows = [
    { cut_id: 7, extras: 1.5, nocturnas: 0, dominicales: 2, festivos: 0 },
    { cut_id: 7, extras: 0.25, nocturnas: 1, dominicales: 0, festivos: 0 },
    { cut_id: 8, extras: 3, nocturnas: 0, dominicales: 0, festivos: 1 },
  ];
  const { log, client } = cutsFake({ results: [{ rows }] });
  const out = await createPayrollRepo(client).sumCutLines({ cutIds: [7, 8, 9], sedeIds: ["copacabana"] });
  assert.deepEqual(out.get(7), { employees: 2, extras: 1.75, nocturnas: 1, dominicales: 2, festivos: 0 });
  assert.deepEqual(out.get(8), { employees: 1, extras: 3, nocturnas: 0, dominicales: 0, festivos: 1 });
  assert.equal(out.has(9), false);
  assert.ok(has(log, "in", "cut_id", [7, 8, 9]));
  assert.ok(has(log, "in", "sede_id", ["copacabana"]));

  const empty = cutsFake();
  assert.equal((await createPayrollRepo(empty.client).sumCutLines({ cutIds: [], sedeIds: ["x"] })).size, 0);
  assert.equal(empty.log.length, 0, "nothing to read");
});
