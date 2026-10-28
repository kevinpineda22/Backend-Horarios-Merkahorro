import { getSupabase } from "../supabase.js";
import { createHttpError } from "./HttpError.js";

/**
 * Supabase JWT authentication.
 *
 * The frontend sends `Authorization: Bearer <Supabase access token>` (the same
 * session the employee uses in the main app). The token is verified with
 * `auth.getUser(token)`, which asks Supabase Auth, so it works with legacy
 * HS256 and asymmetric signing keys alike. No new secret is needed.
 *
 * Verification is injected (`verifyToken`) so tests run without network.
 * Stable error codes: AUTH_REQUIRED (401), AUTH_INVALID (401),
 * AUTH_UNAVAILABLE (503).
 */

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/**
 * `{ id, email }` for a valid token, `null` for an invalid/expired one, and
 * THROWS when Supabase Auth itself fails (network, 5xx, 429): that is not the
 * token's fault.
 */
export function createVerifyToken(client) {
  return async function verifyToken(token) {
    const { data, error } = await client.auth.getUser(token);
    if (error) {
      const status = Number(error.status);
      if (status >= 400 && status < 500 && status !== 429) return null;
      throw error;
    }
    return data?.user ? { id: data.user.id, email: data.user.email } : null;
  };
}

export function createAuthenticate({ verifyToken }) {
  return async function authenticate(req, _res, next) {
    if (req.method === "OPTIONS") return next();

    const match = BEARER.exec(String(req.headers.authorization || ""));
    if (!match) {
      return next(createHttpError(401, "Debes iniciar sesión para usar esta función.", "AUTH_REQUIRED"));
    }

    let user;
    try {
      user = await verifyToken(match[1]);
    } catch {
      return next(
        createHttpError(503, "No se pudo verificar la sesión. Intenta de nuevo en unos segundos.", "AUTH_UNAVAILABLE"),
      );
    }

    if (!user) {
      return next(
        createHttpError(401, "Tu sesión no es válida o venció. Inicia sesión de nuevo.", "AUTH_INVALID"),
      );
    }

    req.user = Object.freeze({ id: user.id, email: String(user.email || "").trim().toLowerCase() });
    return next();
  };
}

/** Real wiring against Supabase; the client is created on the first request. */
export const authenticate = createAuthenticate({
  verifyToken: (token) => createVerifyToken(getSupabase())(token),
});
