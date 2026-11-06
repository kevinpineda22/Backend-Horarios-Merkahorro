import { timingSafeEqual, createHash } from "node:crypto";
import { createHttpError } from "./HttpError.js";

const HEADER = "x-service-key";

// Hashing both sides gives equal-length buffers, so timingSafeEqual never throws on a length
// mismatch and the comparison time does not reveal the length of the real key.
const digest = (value) => createHash("sha256").update(value).digest();

/**
 * Machine-to-machine authentication with a shared secret in the `x-service-key` header.
 *
 *   getKey  () => string | undefined   the expected key, read on every request (e.g. from process.env)
 *
 * Fails closed: an unset or blank key is 503 SERVICE_KEY_NOT_CONFIGURED (never "open"); a missing
 * or wrong header is 401 INVALID_SERVICE_KEY. Neither the expected nor the supplied key is ever
 * logged or echoed.
 */
export function createServiceKeyAuth({ getKey }) {
  return function serviceKeyAuth(req, _res, next) {
    const expected = getKey()?.trim();
    if (!expected) {
      return next(createHttpError(503, "Service authentication is not configured.", "SERVICE_KEY_NOT_CONFIGURED"));
    }
    const supplied = req.headers?.[HEADER];
    const valid = typeof supplied === "string" && supplied !== "" && timingSafeEqual(digest(supplied), digest(expected));
    if (!valid) return next(createHttpError(401, "Invalid service key.", "INVALID_SERVICE_KEY"));
    return next();
  };
}
