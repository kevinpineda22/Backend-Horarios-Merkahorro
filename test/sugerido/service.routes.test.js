import test from "node:test";
import assert from "node:assert/strict";

import { WEEK, makeDeps } from "./api.helpers.js";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createServiceKeyAuth } = await import("../../src/shared/http/serviceKey.js");
const { createSugeridoRouter } = await import("../../src/modules/sugerido/sugerido.routes.js");
const { createSugeridoService } = await import("../../src/modules/sugerido/sugerido.service.js");

const KEY = "unit-test-cron-key";
let authCalls = 0;
let accessCalls = 0;

async function withApp({ key = KEY, ...opts } = {}, fn) {
  const ctx = makeDeps(opts);
  const router = createSugeridoRouter({
    authenticate: (_req, _res, next) => { authCalls += 1; next(); }, // must never be reached by /service
    accessRepo: { findByUserId: async () => { accessCalls += 1; return null; } },
    service: createSugeridoService(ctx.deps),
    serviceKeyAuth: createServiceKeyAuth({ getKey: () => key }),
  });
  const server = createApp({ routes: createRoutes({ modules: { "/sugerido": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/sugerido/service`;
  const call = async (method, path, headers = { "x-service-key": KEY }) => {
    const res = await fetch(base + path, { method, headers });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ ...ctx, call });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const runPath = (sede = "s1", week = WEEK) => `/sedes/${sede}/weeks/${week}/runs`;

test("service routes need the key: 401 wrong/missing, 503 when unconfigured, and no user auth is involved", () =>
  withApp({}, async ({ call, calls, repo }) => {
    for (const [m, p] of [["GET", "/sedes"], ["POST", runPath()]]) {
      assert.equal((await call(m, p, {})).json.code, "INVALID_SERVICE_KEY");
      assert.equal((await call(m, p, { "x-service-key": "nope" })).status, 401);
      assert.equal((await call(m, p, { authorization: "Bearer t-admin" })).status, 401, "a user token is not a service key");
    }
    assert.equal(calls.sales.length + repo.calls.saveRun.length, 0);
    assert.deepEqual([authCalls, accessCalls], [0, 0]);
  }));

test("an unconfigured key fails closed with 503", () =>
  withApp({ key: null }, async ({ call }) => {
    const r = await call("GET", "/sedes");
    assert.deepEqual([r.status, r.json.code], [503, "SERVICE_KEY_NOT_CONFIGURED"]);
  }));

test("GET /service/sedes lists the active sedes only", () =>
  withApp({}, async ({ call }) => {
    const r = await call("GET", "/sedes");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.map((s) => s.sedeId), ["s1", "s2"]);
  }));

test("POST /service run persists with a null (system) actor and returns a compact summary", () =>
  withApp({}, async ({ call, repo }) => {
    const r = await call("POST", runPath());
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.data, { sedeId: "s1", weekStart: WEEK, version: 1, persisted: true, dataAsOf: "2026-11-20" });
    assert.equal(repo.calls.saveRun.length, 1);
    assert.equal(repo.calls.saveRun[0].createdBy, null);
    assert.equal((await call("POST", runPath())).json.data.version, 2);
  }));

test("a run keeps the planner's overrides exactly", () =>
  withApp({}, async ({ call, repo }) => {
    repo.overrides.set(`s1|${WEEK}|08:00`, { sedeId: "s1", fecha: WEEK, franja: "08:00", headcount: 7, suggestedAtEdit: 3, reason: null, updatedBy: "u-planner", updatedAt: "x" });
    const before = structuredClone([...repo.overrides.values()]);
    await call("POST", runPath());
    assert.deepEqual([...repo.overrides.values()], before);
    assert.equal(repo.calls.applyOverrides.length, 0);
  }));

test("validation: non-Monday and unknown sede are rejected like the user endpoint", () =>
  withApp({}, async ({ call, calls }) => {
    assert.equal((await call("POST", runPath("s1", "2026-11-24"))).status, 400);
    assert.equal((await call("POST", runPath("s3"))).status, 404); // inactive sede
    assert.equal((await call("POST", runPath("s1", "2030-01-07"))).json.code, "WEEK_OUT_OF_RANGE");
    assert.equal(calls.sales.length, 0);
  }));

test("a week without sales history answers 200 not persisted, with dataAsOf null", () =>
  withApp({ history: { dataAsOf: null, slots: {}, daily: {}, productivityRows: [] } }, async ({ call }) => {
    const r = await call("POST", runPath());
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, { sedeId: "s1", weekStart: WEEK, version: null, persisted: false, dataAsOf: null });
  }));
