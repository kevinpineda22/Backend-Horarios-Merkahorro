import test from "node:test";
import assert from "node:assert/strict";

const { createPayrollRepo } = await import("../../src/modules/horarios/payroll.supabase.js");

// Records every builder call; serves `total` rows honouring .range (PostgREST caps pages at 1000).
function pagedFake(total, { error = null } = {}) {
  const log = [];
  const all = Array.from({ length: total }, (_, i) => ({ id: i }));
  let range = null;
  const builder = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (res, rej) => {
          if (error) return Promise.resolve({ data: null, error }).then(res, rej);
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
  return { log, client: { from: (t) => (log.push(["from", t]), builder) } };
}
const has = (log, ...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));

test("listShiftsInRange reads every sede and tipo in [from, to], ordered by id, paged until a short page", async () => {
  const { log, client } = pagedFake(2100);
  const rows = await createPayrollRepo(client).listShiftsInRange({ from: "2026-10-25", to: "2026-11-08" });
  assert.equal(rows.length, 2100);
  assert.ok(has(log, "from", "shifts"));
  assert.ok(has(log, "gte", "fecha", "2026-10-25"));
  assert.ok(has(log, "lte", "fecha", "2026-11-08"));
  assert.ok(has(log, "order", "id", { ascending: true }));
  assert.equal(log.some((c) => c[0] === "eq" || c[0] === "in"), false, "no sede or tipo filter");
  assert.deepEqual(log.filter((c) => c[0] === "range"), [["range", 0, 999], ["range", 1000, 1999], ["range", 2000, 2999]]);
  const select = log.find((c) => c[0] === "select")[1];
  for (const col of ["sede_id", "siesa_code", "cedula", "fecha", "tipo", "start_time", "end_time", "break_minutes", "cargo"]) {
    assert.match(select, new RegExp(`\\b${col}\\b`));
  }
});

test("listShiftsInRange asks for one more page when the last page is exactly full", async () => {
  const { log, client } = pagedFake(1000);
  await createPayrollRepo(client).listShiftsInRange({ from: "2026-10-25", to: "2026-11-08" });
  assert.equal(log.filter((c) => c[0] === "range").length, 2);
});

test("listSchedulesInRange reads schedule states for the weeks of the period", async () => {
  const { log, client } = pagedFake(3);
  const rows = await createPayrollRepo(client).listSchedulesInRange({ fromWeek: "2026-10-26", toWeek: "2026-11-02" });
  assert.equal(rows.length, 3);
  assert.ok(has(log, "from", "sede_week_schedules"));
  assert.ok(has(log, "gte", "week_start", "2026-10-26"));
  assert.ok(has(log, "lte", "week_start", "2026-11-02"));
  assert.match(log.find((c) => c[0] === "select")[1], /sede_id, week_start, state/);
});

test("listSedes reads the catalog with the SIESA branch code", async () => {
  const { log, client } = pagedFake(2);
  const rows = await createPayrollRepo(client).listSedes();
  assert.equal(rows.length, 2);
  assert.ok(has(log, "from", "sugerido_sedes"));
  assert.match(log.find((c) => c[0] === "select")[1], /sede_id, siesa_code, activo/);
});

test("read errors are rethrown, never turned into empty data", async () => {
  const boom = { message: "db down" };
  const { client } = pagedFake(1, { error: boom });
  await assert.rejects(createPayrollRepo(client).listSedes(), (e) => e === boom);
});
