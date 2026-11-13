import { createHttpError } from "./HttpError.js";

/**
 * Minimal in-memory fixed-window rate limiter keyed by client IP (no dependency).
 *
 * Only FAILED lookups count (responses whose status is in `countedStatuses`, 400 and 404 by default):
 * successful requests never consume quota, so honest users are not locked out while cedula enumeration
 * (which mostly yields 404/400) is throttled. A client that already reached `max` failures in the window
 * gets 429 before the handler runs.
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
  countedStatuses = [400, 404],
  message = "Demasiados intentos. Intenta de nuevo en unos minutos.",
} = {}) {
  // ip -> { count, resetAt }. Entries are only inserted with resetAt = now + windowMs, so insertion order
  // is also expiry order: the first entries are always the oldest, which keeps pruning and eviction cheap.
  const failures = new Map();
  const counted = new Set(countedStatuses);

  const makeRoom = (t) => {
    for (const [key, entry] of failures) {
      if (entry.resetAt > t) break; // everything after this one expires later
      failures.delete(key);
    }
    // Still full of live entries: drop the oldest so the Map stays bounded.
    for (const key of failures.keys()) {
      if (failures.size < maxKeys) break;
      failures.delete(key);
    }
  };

  const recordFailure = (key) => {
    const t = now();
    let entry = failures.get(key);
    if (entry && entry.resetAt <= t) {
      failures.delete(key); // re-insert below so the key moves to the end (newest)
      entry = undefined;
    }
    if (!entry) {
      if (failures.size >= maxKeys) makeRoom(t);
      entry = { count: 0, resetAt: t + windowMs };
      failures.set(key, entry);
    }
    entry.count += 1;
  };

  return function rateLimit(req, res, next) {
    const t = now();
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    const key = forwarded || req.socket?.remoteAddress || "unknown";

    const entry = failures.get(key);
    if (entry && entry.resetAt > t && entry.count >= max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - t) / 1000))));
      return next(createHttpError(429, message, "RATE_LIMITED"));
    }

    res.once("finish", () => {
      if (counted.has(res.statusCode)) recordFailure(key);
    });
    return next();
  };
}
