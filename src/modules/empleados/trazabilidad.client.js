import { HttpError } from "../../shared/http/HttpError.js";

const PATH = "/api/trazabilidad/service/empleados-activos";
const DEFAULT_TIMEOUT_MS = 8000;

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
  async function fetchEmpleadosActivos() {
    if (!baseUrl || !serviceKey || typeof fetchImpl !== "function") throw unavailable();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${PATH}`, {
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

  return { fetchEmpleadosActivos };
}
