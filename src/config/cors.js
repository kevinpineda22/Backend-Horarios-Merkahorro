import cors from "cors";
import { createHttpError } from "../shared/http/HttpError.js";

/**
 * CORS allowlist. It stops OTHER BROWSER TABS from calling this API; it does
 * not stop curl/Postman (CORS is enforced by the browser). Real protection is
 * the Supabase JWT check in shared/http/authSupabase.js.
 *
 * Requests without an Origin header (curl, Vercel health checks, server to
 * server) are allowed through.
 *
 * `Authorization` is not listed in `allowedHeaders` on purpose: without it the
 * `cors` package reflects the preflight's requested headers. If you ever add
 * `allowedHeaders`, `Authorization` MUST be in it or every frontend call breaks.
 */

const DEFAULT_ORIGINS = [
  "https://merkahorro.com",
  "https://www.merkahorro.com",
  "https://supermercadomerkahorro.com",
  "https://www.supermercadomerkahorro.com",
  // Vite uses 5173 and falls back to 5174 when the port is taken.
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

const stripSlash = (value) => value.replace(/\/$/, "");

export function allowedOrigins(raw = process.env.CORS_ORIGINS) {
  const list = String(raw || "")
    .split(",")
    .map((s) => stripSlash(s.trim()))
    .filter(Boolean);
  return list.length ? list : DEFAULT_ORIGINS;
}

export const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins().includes(stripSlash(origin))) return callback(null, true);

    console.warn(`CORS: origin not allowed -> ${origin}`);
    return callback(createHttpError(403, "Origen no permitido."));
  },
  credentials: true,
});
