import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { createPgPool, getPool } = await import("../../src/shared/db/pg.js");
const { getEnv } = await import("../../src/config/env.js");

test("createPgPool: lazy, max 1, statement_timeout from options; no connection made", async () => {
  let captured = null;
  class FakePool {
    constructor(cfg) {
      captured = cfg;
    }
    on() {}
  }
  const pool = createPgPool({ host: "h", port: 5432, database: "d", user: "u", password: "p", statementTimeoutMs: 8000 }, FakePool);
  assert.ok(pool instanceof FakePool);
  assert.equal(captured.max, 1);
  assert.equal(captured.statement_timeout, 8000);
  assert.equal(captured.host, "h");
});

// Vercel cuts the function at 30 s (vercel.json maxDuration) with a non-JSON 504. A hung
// connect or two long statements must fail first, inside our error mapping.
test("createPgPool: bounded connect timeout so a hung connection fails before Vercel's limit", () => {
  let captured = null;
  class FakePool {
    constructor(cfg) {
      captured = cfg;
    }
    on() {}
  }
  createPgPool({ host: "h", database: "d", user: "u", password: "p" }, FakePool);
  assert.equal(captured.connectionTimeoutMillis, 5000);
});

test("env: POSTGRES_STATEMENT_TIMEOUT_MS is capped at 8000 ms (two statements + connect stay under 30 s)", () => {
  assert.equal(getEnv({ NODE_ENV: "test", POSTGRES_STATEMENT_TIMEOUT_MS: "8000" }).POSTGRES_STATEMENT_TIMEOUT_MS, 8000);
  assert.equal(getEnv({ NODE_ENV: "test" }).POSTGRES_STATEMENT_TIMEOUT_MS, 8000);
  assert.throws(() => getEnv({ NODE_ENV: "test", POSTGRES_STATEMENT_TIMEOUT_MS: "8001" }), /POSTGRES_STATEMENT_TIMEOUT_MS/);
});

test("getPool throws a readable error when POSTGRES_* is not configured", () => {
  assert.throws(() => getPool({}), /POSTGRES/);
});

test("env: POSTGRES_* and TRAZABILIDAD_URL are optional and parsed", () => {
  const env = getEnv({ NODE_ENV: "test", POSTGRES_HOST: "x", POSTGRES_PORT: "6543", TRAZABILIDAD_URL: "https://t.example" });
  assert.equal(env.POSTGRES_HOST, "x");
  assert.equal(env.POSTGRES_PORT, 6543);
  assert.equal(env.TRAZABILIDAD_URL, "https://t.example");
  assert.equal(getEnv({ NODE_ENV: "test" }).POSTGRES_HOST, undefined);
});

// The sales database does not accept SSL; same opt-in rule as Backend-Analitica (POSTGRES_SSLMODE=require).
test("env: POSTGRES_SSL is off unless explicitly set to true", () => {
  assert.equal(getEnv({ NODE_ENV: "test" }).POSTGRES_SSL, false);
  assert.equal(getEnv({ NODE_ENV: "test", POSTGRES_SSL: "false" }).POSTGRES_SSL, false);
  assert.equal(getEnv({ NODE_ENV: "test", POSTGRES_SSL: "true" }).POSTGRES_SSL, true);
});
