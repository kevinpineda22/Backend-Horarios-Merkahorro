import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createHttpError } = await import("../../src/shared/http/HttpError.js");
const { createEmpleadosRouter } = await import("../../src/modules/empleados/empleados.routes.js");
const { createEmpleadosService } = await import("../../src/modules/empleados/empleados.service.js");
const { createLazyTrazabilidadClient } = await import("../../src/modules/empleados/trazabilidad.client.js");

const TOKENS = { "t-admin": "u-admin", "t-planner": "u-planner", "t-viewer": "u-viewer", "t-stranger": "u-none" };
const ACCESS = {
  "u-admin": { role: "admin", sede_ids: null },
  "u-planner": { role: "planner", sede_ids: null },
  "u-viewer": { role: "viewer", sede_ids: ["s1"] },
};
const ROWS = [
  { cedula: "111111", nombre: "Ana", cargo: "Cajera", sede: "Centro", activo: true, restriccionOperativa: "No cargar", restricciones: "SECRET", email: "a@x.co" },
  { cedula: "222222", nombre: "Luis", cargo: "Cajero", sede: "Norte", activo: true },
  { cedula: "333333", nombre: "Mara", cargo: "Cajera", sede: "Lejana", activo: true },
];
const KEYS = ["activo", "cargo", "cedula", "nombre", "restriccionOperativa", "sedeId", "unmappedSede"];

async function start({ fail = false } = {}) {
  const accessRepo = { findByUserId: async (id) => ACCESS[id] ?? null };
  const service = createEmpleadosService({
    client: {
      fetchEmpleadosActivos: async () => {
        if (fail) throw createHttpError(503, "down", "STAFF_SOURCE_UNAVAILABLE");
        return { data: ROWS, total: 3, actualizado: "2026-01-01T00:00:00.000Z" };
      },
    },
    aliasRepo: { loadAliasMap: async () => new Map([["centro", "s1"], ["norte", "s2"]]) },
  });
  const router = createEmpleadosRouter({
    authenticate: createAuthenticate({ verifyToken: async (t) => (TOKENS[t] ? { id: TOKENS[t], email: "x@x.co" } : null) }),
    accessRepo,
    service,
  });
  const server = createApp({ routes: createRoutes({ modules: { "/empleados": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/empleados`;
  const call = async (path, token, method = "GET") => {
    const res = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}
async function withApp(opts, fn) {
  const app = await start(opts);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test("401 without token or with an invalid one", () =>
  withApp({}, async ({ call }) => {
    assert.equal((await call("", null)).status, 401);
    assert.equal((await call("", "bogus")).status, 401);
  }));

test("403 for an authenticated user without an access row", () =>
  withApp({}, async ({ call }) => {
    const res = await call("", "t-stranger");
    assert.equal(res.status, 403);
    assert.equal(res.json.code, "FORBIDDEN_ROLE");
  }));

test("admin gets exact row keys, total and actualizado; no restricciones/email leak", () =>
  withApp({}, async ({ call }) => {
    const res = await call("", "t-admin");
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ["actualizado", "data", "total"]);
    assert.equal(res.json.total, 3);
    assert.equal(res.json.actualizado, "2026-01-01T00:00:00.000Z");
    for (const row of res.json.data) assert.deepEqual(Object.keys(row).sort(), KEYS);
    assert.equal(res.json.data[0].restriccionOperativa, "No cargar");
    assert.doesNotMatch(JSON.stringify(res.json), /SECRET|a@x\.co/);
  }));

test("scoped viewer sees only its sedes; planner with all sedes sees unmapped too", () =>
  withApp({}, async ({ call }) => {
    const viewer = await call("", "t-viewer");
    assert.equal(viewer.status, 200);
    assert.deepEqual(viewer.json.data.map((r) => r.cedula), ["111111"]);
    assert.equal(viewer.json.total, 1);
    const planner = await call("", "t-planner");
    assert.equal(planner.json.data.length, 3);
  }));

test("query filters work and sede outside scope -> 403 FORBIDDEN_SEDE", () =>
  withApp({}, async ({ call }) => {
    assert.deepEqual((await call("?q=ana", "t-admin")).json.data.map((r) => r.cedula), ["111111"]);
    assert.deepEqual((await call("?cargo=cajero&sede=s2", "t-admin")).json.data.map((r) => r.cedula), ["222222"]);
    const denied = await call("?sede=s2", "t-viewer");
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, "FORBIDDEN_SEDE");
  }));

test("invalid query -> 400", () =>
  withApp({}, async ({ call }) => {
    assert.equal((await call(`?q=${"a".repeat(101)}`, "t-admin")).status, 400);
    assert.equal((await call("?sede=", "t-admin")).status, 400);
  }));

test("only GET is exposed", () =>
  withApp({}, async ({ call }) => {
    assert.equal((await call("", "t-admin", "POST")).status, 404);
  }));

test("source down -> 503 STAFF_SOURCE_UNAVAILABLE (never an empty list)", () =>
  withApp({ fail: true }, async ({ call }) => {
    const res = await call("", "t-admin");
    assert.equal(res.status, 503);
    assert.equal(res.json.code, "STAFF_SOURCE_UNAVAILABLE");
    assert.equal(res.json.data, undefined);
  }));

test("lazy trazabilidad client: no work at construction; missing config -> 503 at call time", async () => {
  let reads = 0;
  const lazy = createLazyTrazabilidadClient(() => (reads++, {}));
  assert.equal(reads, 0);
  await assert.rejects(lazy.fetchEmpleadosActivos(), { statusCode: 503, code: "STAFF_SOURCE_UNAVAILABLE" });
  assert.equal(reads, 1);
});

test("lazy trazabilidad client: uses configured url/key and builds the client once", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => (calls.push([url, init.headers["x-api-key"]]), { ok: true, json: async () => ({ data: [] }) });
  let reads = 0;
  const lazy = createLazyTrazabilidadClient(() => (reads++, { TRAZABILIDAD_URL: "https://t.example", TRAZABILIDAD_SERVICE_KEY: "k" }), { fetchImpl });
  await lazy.fetchEmpleadosActivos();
  await lazy.fetchEmpleadosActivos();
  assert.equal(reads, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["https://t.example/api/trazabilidad/service/empleados-activos", "k"]);
});
