import pg from "pg";
import { getEnv } from "../../config/env.js";

/**
 * Builds a pg pool without connecting (pg connects on the first query).
 * max 1: each serverless instance handles one request at a time, and a bigger
 * pool would exhaust the database connection limit under concurrency.
 * `PoolClass` is injectable for tests.
 */
export function createPgPool(options, PoolClass = pg.Pool) {
  const pool = new PoolClass({
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.user,
    password: options.password,
    ssl: options.ssl,
    max: 1,
    idleTimeoutMillis: 10_000,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
  });
  // An idle-client error must not crash the process.
  pool.on("error", (err) => console.error("pg pool error:", err.message));
  return pool;
}

let pool = null;

/** Lazy shared pool for the sales database (read-only usage). */
export function getPool(source) {
  if (pool && !source) return pool;

  const env = source ?? getEnv();
  const missing = ["POSTGRES_HOST", "POSTGRES_DATABASE", "POSTGRES_USER", "POSTGRES_PASSWORD"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing database configuration: ${missing.join(", ")}`);

  const created = createPgPool({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    database: env.POSTGRES_DATABASE,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    // rejectUnauthorized stays false on purpose: the Supabase pooler presents a
    // certificate that Node does not trust by default. Traffic is still encrypted.
    ssl: env.POSTGRES_SSL ? { rejectUnauthorized: false } : undefined,
    statementTimeoutMs: env.POSTGRES_STATEMENT_TIMEOUT_MS,
  });
  if (!source) pool = created;
  return created;
}
