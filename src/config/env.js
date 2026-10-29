import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3003),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  CORS_ORIGINS: z.string().default(""),
  // Sales database (pg) and staff service; optional so other modules run without them.
  POSTGRES_HOST: z.string().min(1).optional(),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DATABASE: z.string().min(1).optional(),
  POSTGRES_USER: z.string().min(1).optional(),
  POSTGRES_PASSWORD: z.string().min(1).optional(),
  POSTGRES_SSL: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // Capped: a run issues two statements plus a 5 s connect, and Vercel cuts the function at 30 s.
  POSTGRES_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().max(8000).default(8000),
  TRAZABILIDAD_URL: z.string().url().optional(),
  TRAZABILIDAD_SERVICE_KEY: z.string().min(1).optional(),
});

// Offline defaults so `npm test` never needs real credentials.
const TEST_DEFAULTS = {
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SERVICE_KEY: "test-service-key",
};

let cached = null;

/**
 * Validated environment, parsed lazily on first use (not at import time) so
 * modules that do not need Supabase can be imported without credentials.
 * Fails fast with a readable message listing every invalid variable.
 */
export function getEnv(source = process.env) {
  if (source === process.env && cached) return cached;

  const input = source.NODE_ENV === "test" ? { ...TEST_DEFAULTS, ...source } : source;
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}\nSee .env.example.`);
  }

  if (source === process.env) cached = result.data;
  return result.data;
}
