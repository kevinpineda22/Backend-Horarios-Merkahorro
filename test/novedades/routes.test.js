import test from "node:test";
import assert from "node:assert/strict";
import { createFakeRepo, ID_A, ID_B, ID_C } from "./helpers.js";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createNovedadesRouter } = await import("../../src/modules/novedades/novedades.routes.js");
const { createNovedadesService } = await import("../../src/modules/novedades/novedades.service.js");

// token -> user; user -> access row (sugerido_access shape). Expectations come from spec R7.7.
const USERS = { "t-admin": "u-admin", "t-planner": "u-planner", "t-planner-all": "u-planner-all", "t-viewer": "u-viewer", "t-norole": "u-norole" };
const ACCESS = {
  "u-admin": { role: "admin", sede_ids: null },
  "u-planner": { role: "planner", sede_ids: ["s1"] },
  "u-planner-all": { role: "planner", sede_ids: null },
  "u-viewer": { role: "viewer", sede_ids: ["s1"] },
};

const row = (o) => ({ cedula: "1020304050", tipo: "Permisos", fecha_inicio: "2026-11-10", fecha_fin: "2026-11-20", sede_id: "s1", ...o });
const body = { cedula: "1020304050", tipo: "Vacaciones", fechaInicio: "2026-11-03", fechaFin: "2026-11-14", sedeId: "s1" };

async function start(seed = []) {
  const repo = createFakeRepo(seed);
  const router = createNovedadesRouter({
    authenticate: createAuthenticate({
      verifyToken: async (t) => (USERS[t] ? { id: USERS[t], email: `${USERS[t]}@x.co` } : null),
    }),
    accessRepo: { findByUserId: async (id) => ACCESS[id] ?? null },
    service: createNovedadesService({ repo }),
  });
  const server = createApp({ routes: createRoutes({ modules: { "/novedades": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/novedades`;
  const call = async (method, path, token, json) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { repo, call, close: () => new Promise((r) => server.close(r)) };
}

async function withApp(seed, fn) {
  const app = await start(seed);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test("authentication: 401 without token or with an invalid one; 403 for a user without access row", () =>
  withApp([], async ({ call }) => {
    for (const [m, p, b] of [["GET", "/"], ["GET", `/${ID_A}`], ["POST", "/", body], ["PATCH", `/${ID_A}`, { tipo: "Estudio" }], ["POST", `/${ID_A}/anular`, { motivo: "m" }]]) {
      assert.equal((await call(m, p, null, b)).status, 401, `${m} ${p}`);
      assert.equal((await call(m, p, "bogus", b)).status, 401, `${m} ${p} bogus`);
      const r = await call(m, p, "t-norole", b);
      assert.equal(r.status, 403, `${m} ${p} norole`);
      assert.equal(r.json.code, "FORBIDDEN_ROLE");
    }
  }));

test("viewer: read-only; writes are 403 even when the body is invalid (role check first)", () =>
  withApp([row({ id: ID_A })], async ({ call, repo }) => {
    assert.equal((await call("GET", "/", "t-viewer")).status, 200);
    assert.equal((await call("GET", `/${ID_A}`, "t-viewer")).status, 200);
    for (const [m, p, b] of [["POST", "/", body], ["POST", "/", {}], ["PATCH", `/${ID_A}`, { tipo: "Estudio" }], ["POST", `/${ID_A}/anular`, { motivo: "m" }]]) {
      const r = await call(m, p, "t-viewer", b);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.json.code, "FORBIDDEN_ROLE");
    }
    assert.equal(repo.calls.insert.length + repo.calls.update.length, 0);
  }));

test("viewer sede scoping: other sede 403, null-sede rows invisible/forbidden", () =>
  withApp([row({ id: ID_A, sede_id: "s2" }), row({ id: ID_B, sede_id: null }), row({ id: ID_C, sede_id: "s1" })], async ({ call }) => {
    assert.equal((await call("GET", "/?sede=s2", "t-viewer")).json.code, "FORBIDDEN_SEDE");
    assert.equal((await call("GET", `/${ID_A}`, "t-viewer")).status, 403);
    assert.equal((await call("GET", `/${ID_B}`, "t-viewer")).status, 403);
    assert.deepEqual((await call("GET", "/", "t-viewer")).json.data.map((d) => d.id), [ID_C]);
    // an all-sedes planner is still not admin: null-sede rows stay hidden
    assert.equal((await call("GET", `/${ID_B}`, "t-planner-all")).status, 403);
    assert.deepEqual((await call("GET", "/", "t-planner-all")).json.data.map((d) => d.id).sort(), [ID_A, ID_C].sort());
    // admin sees everything
    assert.equal((await call("GET", "/", "t-admin")).json.data.length, 3);
    assert.equal((await call("GET", `/${ID_B}`, "t-admin")).status, 200);
  }));

test("planner: writes inside own sede, 403 elsewhere or without sedeId", () =>
  withApp([row({ id: ID_A, sede_id: "s1" }), row({ id: ID_B, sede_id: "s2", cedula: "555555" }), row({ id: ID_C, sede_id: null, cedula: "666666" })], async ({ call, repo }) => {
    const ok = await call("POST", "/", "t-planner", body);
    assert.equal(ok.status, 201);
    assert.equal(ok.json.data.sedeId, "s1");
    const before = repo.rows.length;
    assert.equal((await call("POST", "/", "t-planner", { ...body, sedeId: "s2" })).json.code, "FORBIDDEN_SEDE");
    assert.equal((await call("POST", "/", "t-planner", { ...body, sedeId: undefined })).json.code, "FORBIDDEN_SEDE");
    assert.equal((await call("POST", "/", "t-planner-all", { ...body, sedeId: undefined })).json.code, "FORBIDDEN_SEDE");
    assert.equal(repo.rows.length, before);

    assert.equal((await call("PATCH", `/${ID_A}`, "t-planner", { observacion: "ok" })).status, 200);
    for (const id of [ID_B, ID_C]) {
      assert.equal((await call("PATCH", `/${id}`, "t-planner", { observacion: "x" })).status, 403);
      assert.equal((await call("POST", `/${id}/anular`, "t-planner", { motivo: "m" })).status, 403);
    }
    assert.equal((await call("POST", `/${ID_A}/anular`, "t-planner", { motivo: "dup" })).status, 200);
  }));

test("admin may create and manage null-sede rows", () =>
  withApp([], async ({ call }) => {
    const r = await call("POST", "/", "t-admin", { ...body, sedeId: undefined });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.sedeId, null);
    assert.equal((await call("PATCH", `/${r.json.data.id}`, "t-admin", { observacion: "x" })).status, 200);
  }));

test("create: audit from the token, body spoof ignored, response shape and overlap warning", () =>
  withApp([row({ id: ID_A, fecha_inicio: "2026-11-14", fecha_fin: "2026-11-16" })], async ({ call, repo }) => {
    const r = await call("POST", "/", "t-planner", { ...body, cedula: "1.020.304.050", created_by: "other", anulada: true });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.createdBy, "u-planner");
    assert.equal(r.json.data.anulada, false);
    assert.equal(r.json.data.cedula, "1020304050");
    assert.deepEqual(r.json.warnings, [{ code: "OVERLAP", ids: [ID_A] }]);
    assert.equal(repo.calls.insert[0].created_by, "u-planner");
  }));

test("validation: 400 VALIDATION_ERROR with details and nothing persisted", () =>
  withApp([row({ id: ID_A })], async ({ call, repo }) => {
    const bads = [
      { ...body, fechaFin: "2026-11-02" },
      { ...body, tipo: "Sabático" },
      { ...body, cedula: "12" },
      { ...body, fechaInicio: "2026-02-30" },
      { tipo: "Vacaciones" },
    ];
    for (const b of bads) {
      const r = await call("POST", "/", "t-admin", b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.json.code, "VALIDATION_ERROR");
      assert.ok(r.json.details.length > 0);
    }
    assert.equal(repo.calls.insert.length, 0);

    assert.equal((await call("PATCH", `/${ID_A}`, "t-admin", {})).status, 400);
    assert.equal((await call("PATCH", "/not-a-uuid", "t-admin", { tipo: "Estudio" })).status, 400);
    assert.equal((await call("PATCH", `/${ID_A}`, "t-admin", { fechaFin: "2026-11-01" })).status, 400); // merged range
    assert.equal((await call("POST", `/${ID_A}/anular`, "t-admin", {})).status, 400);
    assert.equal((await call("POST", `/${ID_A}/anular`, "t-admin", { motivo: "x".repeat(501) })).status, 400);
    assert.equal((await call("GET", "/?desde=2026-11-30&hasta=2026-11-01", "t-admin")).status, 400);
    assert.equal((await call("GET", "/not-a-uuid", "t-admin")).status, 400);
    assert.equal(repo.calls.update.length, 0);
    assert.equal(repo.rows[0].anulada, false);
  }));

test("404 for unknown ids; 409 NOVEDAD_CANCELLED on PATCH/anular of a cancelled row", () =>
  withApp([row({ id: ID_A, anulada: true, anulada_at: "t" })], async ({ call, repo }) => {
    assert.equal((await call("GET", `/${ID_B}`, "t-admin")).json.code, "NOVEDAD_NOT_FOUND");
    assert.equal((await call("PATCH", `/${ID_B}`, "t-admin", { tipo: "Estudio" })).status, 404);
    assert.equal((await call("POST", `/${ID_B}/anular`, "t-admin", { motivo: "m" })).status, 404);
    const p = await call("PATCH", `/${ID_A}`, "t-admin", { tipo: "Estudio" });
    assert.equal(p.status, 409);
    assert.equal(p.json.code, "NOVEDAD_CANCELLED");
    assert.equal((await call("POST", `/${ID_A}/anular`, "t-admin", { motivo: "m" })).status, 409);
    assert.equal(repo.calls.update.length, 0);
    assert.equal((await call("GET", `/${ID_A}`, "t-admin")).status, 200); // cancelled rows stay readable
  }));

test("anular: soft cancel with audit; row leaves the default list but stays retrievable", () =>
  withApp([row({ id: ID_A })], async ({ call, repo }) => {
    const r = await call("POST", `/${ID_A}/anular`, "t-admin", { motivo: "digitada dos veces" });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.anulada, true);
    assert.equal(r.json.data.motivoAnulacion, "digitada dos veces");
    assert.equal(r.json.data.anuladaPor, "u-admin");
    assert.ok(r.json.data.anuladaAt);
    assert.equal(repo.rows.length, 1);
    assert.equal((await call("GET", "/", "t-admin")).json.data.length, 0);
    assert.equal((await call("GET", "/?incluirAnuladas=true", "t-admin")).json.data.length, 1);
  }));

test("list filters: cedula, tipo, sede, overlap range (inclusive), ordering and shape", () =>
  withApp(
    [
      row({ id: ID_A, fecha_inicio: "2026-11-10", fecha_fin: "2026-11-20" }),
      row({ id: ID_B, cedula: "777777", tipo: "Estudio", fecha_inicio: "2026-12-01", fecha_fin: "2026-12-02", sede_id: "s2" }),
      row({ id: ID_C, cedula: "777777", tipo: "Estudio", fecha_inicio: "2026-01-01", fecha_fin: "2026-01-02" }),
    ],
    async ({ call }) => {
      const ids = async (q) => (await call("GET", `/${q}`, "t-admin")).json.data.map((d) => d.id);
      assert.deepEqual(await ids("?desde=2026-11-18&hasta=2026-11-25"), [ID_A]);
      assert.deepEqual(await ids("?desde=2026-11-20&hasta=2026-11-25"), [ID_A]);
      assert.deepEqual(await ids("?desde=2026-11-21&hasta=2026-11-25"), []);
      assert.deepEqual(await ids("?hasta=2026-11-09"), [ID_C]);
      assert.deepEqual(await ids("?cedula=777.777"), [ID_B, ID_C]);
      assert.deepEqual(await ids("?cedula=777777&sede=s1"), [ID_C]);
      assert.deepEqual(await ids("?tipo=Estudio"), [ID_B, ID_C]);
      const all = await call("GET", "/", "t-admin");
      assert.deepEqual(all.json.data.map((d) => d.id), [ID_B, ID_A, ID_C]); // fecha_inicio desc
      assert.equal(all.json.truncated, false);
      assert.deepEqual(all.json.warnings, []);
    },
  ));

test("default composition root mounts /api/novedades behind authentication (no network needed)", async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/novedades`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, "AUTH_REQUIRED");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
