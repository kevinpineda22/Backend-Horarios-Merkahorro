import { createHttpError } from "./HttpError.js";

/**
 * Minimal in-memory fixed-window rate limiter keyed by client IP (no dependency).
 *
 * BEST EFFORT ONLY: on Vercel every serverless instance keeps its own Map, so the real ceiling is
 * `max` per instance, and a cold start resets it. It slows down cedula enumeration; it is not a
 * hard guarantee. Use an external store (Redis/Upstash, Vercel WAF rules) if a strict limit is needed.
 *
 * The client IP comes from the first `x-forwarded-for` entry (Vercel overwrites the header, so a client
 * cannot choose it there), falling back to the socket address.
 */
export function createRateLimiter({
  windowMs = 5 * 60 * 1000,
  max = 20,
  now = Date.now,
  maxKeys = 10_000,
  message = "Demasiados intentos. Intenta de nuevo en unos minutos.",
} = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  const prune = (t) => {
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
  };

  return function rateLimit(req, res, next) {
    const t = now();
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    const key = forwarded || req.socket?.remoteAddress || "unknown";

    if (hits.size >= maxKeys) prune(t);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - t) / 1000))));
      return next(createHttpError(429, message, "RATE_LIMITED"));
    }
    return next();
  };
}
