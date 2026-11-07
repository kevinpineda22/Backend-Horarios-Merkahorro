import test from "node:test";
import assert from "node:assert/strict";
import { createSalesRepo } from "../../src/modules/sugerido/repositories/sales.pg.js";

// Fake pool answering the single register-count statement.
function fakePool({ rows = [], failOn = null } = {}) {
  const log = [];
  const client = {
    async query(sql, params) {
      log.push({ sql: String(sql), params });
      if (failOn && String(sql).includes(failOn.match)) throw failOn.error;
      if (/count\(DISTINCT/i.test(sql)) return { rows };
      return { rows: [] };
    },
    release(arg) {
      log.push({ release: arg });
    },
  };
  return { log, pool: { connect: async () => client } };
}

test("loadRegisterCounts maps bodega -> distinct registers (numerics arrive as strings)", async () => {
  const { pool } = fakePool({ rows: [{ bodega: "PV001", registers: "10" }, { bodega: "00201", registers: 4 }] });
  const out = await createSalesRepo(pool).loadRegisterCounts({ bodegas: ["PV001", "00201", "PV009"], hasta: "2026-11-23" });
  assert.deepEqual(out, { PV001: 10, "00201": 4 });
});

test("one parameterized READ ONLY round trip over a 60-day window ending at each bodega's latest date", async () => {
  const { pool, log } = fakePool();
  await createSalesRepo(pool).loadRegisterCounts({ bodegas: ["PV001"], hasta: "2026-11-23" });
  const stmts = log.filter((l) => l.sql);
  assert.equal(stmts.length, 3, "BEGIN, one query, COMMIT");
  assert.match(stmts[0].sql, /^BEGIN READ ONLY$/);
  assert.match(stmts[2].sql, /^COMMIT$/);
  const q = stmts[1];
  assert.deepEqual(q.params, [["PV001"], "2026-11-23"]);
  assert.match(q.sql, /bodega = ANY\(\$1::text\[\]\)/);
  assert.match(q.sql, /\$2::date IS NULL OR fecha <= \$2::date/);
  assert.match(q.sql, /fecha > r\.d - 60/);
  assert.match(q.sql, /fecha <= r\.d/);
  // '1' and '01' must be the same register: trimmed and stripped of leading zeros inside the DISTINCT.
  assert.match(q.sql, /count\(DISTINCT ltrim\(btrim\(t\.caja::text\), '0'\)\)/);
  assert.match(q.sql, /SIN_CAJA/);
  assert.match(q.sql, /btrim/);
  assert.match(q.sql, /GROUP BY t\.bodega/);
  assert.ok(!q.sql.includes("PV001") && !q.sql.includes("2026"), "no interpolated values");
  assert.deepEqual(log.at(-1), { release: undefined });
});

test("hasta is optional: null means no horizon bound", async () => {
  const { pool, log } = fakePool();
  await createSalesRepo(pool).loadRegisterCounts({ bodegas: ["PV001"] });
  assert.deepEqual(log.find((l) => /count\(DISTINCT/i.test(l.sql)).params, [["PV001"], null]);
});

test("empty or invalid bodegas / hasta are rejected before any connection", async () => {
  const { pool, log } = fakePool();
  const repo = createSalesRepo(pool);
  await assert.rejects(repo.loadRegisterCounts({ bodegas: [] }), /bodegas/);
  await assert.rejects(repo.loadRegisterCounts({ bodegas: [""] }), /bodegas/);
  await assert.rejects(repo.loadRegisterCounts({ bodegas: ["A"], hasta: "2026-13-40" }));
  assert.equal(log.length, 0);
});

test("a malformed count fails with SALES_DATA_INVALID instead of becoming 0", async () => {
  for (const registers of [null, "abc", "-1", "1.5"]) {
    const { pool } = fakePool({ rows: [{ bodega: "PV001", registers }] });
    await assert.rejects(
      createSalesRepo(pool).loadRegisterCounts({ bodegas: ["PV001"] }),
      (e) => e.statusCode === 502 && e.code === "SALES_DATA_INVALID",
      String(registers),
    );
  }
});

test("database failures map to 503 / 504 and the client is destroyed", async () => {
  const down = fakePool({ failOn: { match: "count(DISTINCT", error: new Error("boom") } });
  await assert.rejects(createSalesRepo(down.pool).loadRegisterCounts({ bodegas: ["A"] }), (e) => e.statusCode === 503 && e.code === "SALES_DB_UNAVAILABLE");
  assert.ok(down.log.some((l) => "release" in l && l.release instanceof Error));
  const slow = fakePool({ failOn: { match: "count(DISTINCT", error: Object.assign(new Error("t"), { code: "57014" }) } });
  await assert.rejects(createSalesRepo(slow.pool).loadRegisterCounts({ bodegas: ["A"] }), (e) => e.statusCode === 504 && e.code === "SALES_DB_TIMEOUT");
});
