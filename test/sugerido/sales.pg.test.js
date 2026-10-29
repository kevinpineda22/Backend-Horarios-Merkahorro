import test from "node:test";
import assert from "node:assert/strict";
import { createSalesRepo } from "../../src/modules/sugerido/repositories/sales.pg.js";

// Fake pg pool: connect() hands out a client that logs every statement and answers
// the history query and the max(fecha) query from `fixtures`.
function fakePool({ rows = [], asOf = null, failOn = null, failRollback = false } = {}) {
  const log = [];
  const client = {
    async query(sql, params) {
      log.push({ sql: String(sql), params });
      if (failOn && String(sql).includes(failOn.match)) throw failOn.error;
      if (/ROLLBACK/i.test(sql) && failRollback) throw new Error("rollback failed");
      if (/max\(fecha\)/i.test(sql)) return { rows: [{ data_as_of: asOf }] };
      if (/GROUP BY/i.test(sql)) return { rows };
      return { rows: [] };
    },
    release(arg) {
      log.push({ release: arg });
    },
  };
  return { log, pool: { connect: async () => client } };
}
const ARGS = { bodegas: ["00201", "PV002"], desde: "2026-01-01", hasta: "2026-10-26" };
const row = (o = {}) => ({ fecha: "2026-10-20", franja: "08:00:00", facturas: "10", devoluciones: "2", venta: "150000.50", cajeras: "3", ...o });

test("builds slots, daily and productivity rows; docs = facturas + devoluciones; franja HH:MM", async () => {
  const { pool } = fakePool({
    asOf: "2026-10-26",
    rows: [row(), row({ franja: "08:15:00", facturas: "5", devoluciones: "0", venta: "20", cajeras: "2" }), row({ fecha: "2026-10-21", franja: "09:00:00", facturas: "1", devoluciones: "0", venta: "1", cajeras: "1" })],
  });
  const res = await createSalesRepo(pool).loadSlotHistory(ARGS);
  assert.deepEqual(res.slots, {
    "2026-10-20": { "08:00": { docs: 12, venta: 150000.5 }, "08:15": { docs: 5, venta: 20 } },
    "2026-10-21": { "09:00": { docs: 1, venta: 1 } },
  });
  assert.deepEqual(res.daily, { "2026-10-20": 17, "2026-10-21": 1 });
  assert.deepEqual(res.productivityRows[0], { fecha: "2026-10-20", franja: "08:00", docs: 12, cajeras: 3 });
  assert.equal(res.productivityRows.length, 3);
  assert.equal(res.dataAsOf, "2026-10-26");
});

test("SQL is parameterized, text-cast, multi-bodega and read-only", async () => {
  const { pool, log } = fakePool();
  await createSalesRepo(pool).loadSlotHistory(ARGS);
  const q = log.find((l) => /GROUP BY/i.test(l.sql));
  assert.deepEqual(q.params, [["00201", "PV002"], "2026-01-01", "2026-10-26"]);
  assert.match(q.sql, /bodega = ANY\(\$1::text\[\]\)/);
  assert.match(q.sql, /fecha >= \$2::date/);
  assert.match(q.sql, /fecha <= \$3::date/);
  assert.match(q.sql, /fecha::text/);
  assert.match(q.sql, /GROUP BY fecha, franja/i);
  assert.match(q.sql, /SUM\(venta\)/i);
  assert.ok(!q.sql.includes("00201") && !q.sql.includes("2026"), "no interpolated values");
  const m = log.find((l) => /max\(fecha\)/i.test(l.sql));
  assert.deepEqual(m.params, [["00201", "PV002"], "2026-10-26"]);
  assert.match(m.sql, /fecha <= \$2::date/);
  assert.match(m.sql, /max\(fecha\)::text/i);
  assert.match(m.sql, /WHERE bodega = ANY\(\$1::text\[\]\)/);
  const stmts = log.filter((l) => l.sql).map((l) => l.sql);
  assert.match(stmts[0], /^BEGIN READ ONLY$/);
  assert.match(stmts.at(-1), /^COMMIT$/);
  assert.deepEqual(log.at(-1), { release: undefined });
});

// The DDL writes 'sin_cajera' when an invoice has no user. Those invoices are real demand
// (docs and venta stay unfiltered) but must not count as one more cashier in the slot.
test("cashier count excludes the 'sin_cajera' placeholder and blanks; docs and venta do not", async () => {
  const { pool, log } = fakePool();
  await createSalesRepo(pool).loadSlotHistory(ARGS);
  const sql = log.find((l) => /GROUP BY/i.test(l.sql)).sql.replace(/\s+/g, " ");
  assert.match(
    sql,
    /count\(DISTINCT cajera\) FILTER \(WHERE cajera IS NOT NULL AND btrim\(cajera\) <> '' AND lower\(btrim\(cajera\)\) <> 'sin_cajera'\) AS cajeras/i,
  );
  assert.match(sql, /COALESCE\(SUM\(facturas\), 0\) AS facturas/i);
  assert.match(sql, /COALESCE\(SUM\(venta\), 0\) AS venta/i);
});

test("empty history -> empty shapes and null dataAsOf (not an error)", async () => {
  const { pool } = fakePool();
  assert.deepEqual(await createSalesRepo(pool).loadSlotHistory(ARGS), { dataAsOf: null, slots: {}, daily: {}, productivityRows: [] });
});

test("pg errors -> 503 SALES_DB_UNAVAILABLE; statement timeout -> 504 SALES_DB_TIMEOUT; rolls back and destroys client", async () => {
  const boom = Object.assign(new Error("connection refused host=secret"), { code: "ECONNREFUSED" });
  const { pool, log } = fakePool({ failOn: { match: "GROUP BY", error: boom } });
  await assert.rejects(createSalesRepo(pool).loadSlotHistory(ARGS), (e) => e.statusCode === 503 && e.code === "SALES_DB_UNAVAILABLE" && e.expose && !/secret/.test(e.message));
  assert.ok(log.some((l) => l.sql === "ROLLBACK"));
  assert.ok(log.some((l) => "release" in l && l.release === boom));

  const t = fakePool({ failOn: { match: "GROUP BY", error: Object.assign(new Error("canceling"), { code: "57014" }) } });
  await assert.rejects(createSalesRepo(t.pool).loadSlotHistory(ARGS), (e) => e.statusCode === 504 && e.code === "SALES_DB_TIMEOUT");

  const c = { connect: async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); } };
  await assert.rejects(createSalesRepo(c).loadSlotHistory(ARGS), (e) => e.code === "SALES_DB_UNAVAILABLE");

  const r = fakePool({ failOn: { match: "GROUP BY", error: boom }, failRollback: true });
  await assert.rejects(createSalesRepo(r.pool).loadSlotHistory(ARGS), (e) => e.code === "SALES_DB_UNAVAILABLE");
});

test("invalid numerics, nulls, bad franja or duplicate slot -> 502 SALES_DATA_INVALID", async () => {
  const bad = [
    row({ facturas: "abc" }), row({ venta: null }), row({ devoluciones: "" }), row({ cajeras: "NaN" }),
    row({ franja: "08:07:00" }), row({ fecha: "bogus" }),
  ];
  for (const b of bad) {
    const { pool } = fakePool({ rows: [b] });
    await assert.rejects(createSalesRepo(pool).loadSlotHistory(ARGS), (e) => e.statusCode === 502 && e.code === "SALES_DATA_INVALID", JSON.stringify(b));
  }
  const dup = fakePool({ rows: [row(), row({ franja: "08:00" })] });
  await assert.rejects(createSalesRepo(dup.pool).loadSlotHistory(ARGS), (e) => e.code === "SALES_DATA_INVALID");
});

test("rejects bad arguments before touching the pool", async () => {
  const pool = { connect: async () => assert.fail("must not connect") };
  const repo = createSalesRepo(pool);
  await assert.rejects(repo.loadSlotHistory({ ...ARGS, bodegas: [] }), /bodegas/);
  await assert.rejects(repo.loadSlotHistory({ ...ARGS, bodegas: ["ok", 5] }), /bodegas/);
  await assert.rejects(repo.loadSlotHistory({ ...ARGS, desde: "2026-02-30" }), /Invalid date/);
  await assert.rejects(repo.loadSlotHistory({ ...ARGS, hasta: "x" }), /Invalid date/);
  await assert.rejects(repo.loadSlotHistory({ ...ARGS, desde: "2026-10-27", hasta: "2026-10-26" }), /desde/);
  await repo.loadSlotHistory({ ...ARGS, desde: "2026-10-26", hasta: "2026-10-26" }).catch((e) => {
    assert.doesNotMatch(String(e.message), /desde/, "a single-day range is valid");
  });
});
