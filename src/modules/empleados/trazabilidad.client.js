import { HttpError } from "../../shared/http/HttpError.js";

const PATH_ACTIVOS = "/api/trazabilidad/service/empleados-activos";
const PATH_PRECONTRACTUALES = "/api/trazabilidad/service/empleados-precontractuales";
const DEFAULT_TIMEOUT_MS = 8000;
// Optional source: it must not keep the whole directory waiting.
const PRECONTRACTUALES_TIMEOUT_MS = 4000;

const unavailable = () =>
  new HttpError(503, "Employee directory is temporarily unavailable", "STAFF_SOURCE_UNAVAILABLE");

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Client for the trazabilidad service endpoint. Authenticates with the service API key
 * only; the caller's user token is never forwarded. Every failure (missing config,
 * timeout, network, non-2xx, malformed body) becomes 503 STAFF_SOURCE_UNAVAILABLE so
 * callers can never mistake an outage for an empty staff list.
 */
export function createTrazabilidadClient({
  baseUrl,
  serviceKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
} = {}) {
  async function fetchRows(path, waitMs = timeoutMs) {
    if (!baseUrl || !serviceKey || typeof fetchImpl !== "function") throw unavailable();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs);
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${path}`, {
        method: "GET",
        headers: { "x-api-key": serviceKey, accept: "application/json" },
        signal: controller.signal,
        // Any redirect fails the request, so the key is never replayed to another origin.
        redirect: "error",
      });
      if (!response?.ok) {
        // Status only: never the key, the URL or the upstream body.
        logger?.warn?.("[empleados] trazabilidad status", response?.status);
        throw unavailable();
      }

      const body = await response.json();
      if (!isPlainObject(body) || !Array.isArray(body.data) || !body.data.every(isPlainObject)) {
        throw unavailable();
      }
      return { data: body.data, total: body.total, actualizado: body.actualizado };
    } catch (err) {
      throw err instanceof HttpError ? err : unavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  return { fetchEmpleadosActivos: () => fetchRows(PATH_ACTIVOS), fetchPrecontractuales: () => fetchRows(PATH_PRECONTRACTUALES, Math.min(timeoutMs, PRECONTRACTUALES_TIMEOUT_MS)) };
}

/**
 * Defers reading the configuration and building the client until the first request, so
 * importing the app never needs credentials or the network. Missing config surfaces as
 * 503 STAFF_SOURCE_UNAVAILABLE at request time (the client enforces it).
 */
export function createLazyTrazabilidadClient(getConfig, options = {}) {
  let client = null;
  const get = () => {
    if (!client) {
      const { TRAZABILIDAD_URL, TRAZABILIDAD_SERVICE_KEY } = getConfig();
      client = createTrazabilidadClient({ baseUrl: TRAZABILIDAD_URL, serviceKey: TRAZABILIDAD_SERVICE_KEY, ...options });
    }
    return client;
  };
  return {
    fetchEmpleadosActivos: () => get().fetchEmpleadosActivos(),
    fetchPrecontractuales: () => get().fetchPrecontractuales(),
  };
}
