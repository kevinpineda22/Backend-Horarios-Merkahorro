import test from "node:test";
import assert from "node:assert/strict";

import { createHttpError } from "../../src/shared/http/HttpError.js";
import { WEEK, buildHistory, makeDeps } from "./api.helpers.js";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createSugeridoRouter } = await import("../../src/modules/sugerido/sugerido.routes.js");
const { createSugeridoService } = await import("../../src/modules/sugerido/sugerido.service.js");

const USERS = { "t-admin": "u-admin", "t-planner": "u-planner", "t-planner-all": "u-planner-all", "t-viewer": "u-viewer", "t-norole": "u-norole" };
const ACCESS = {
  "u-admin": { role: "admin", sede_ids: null },
  "u-planner": { role: "planner", sede_ids: ["s1"] },
  "u-planner-all": { role: "planner", sede_ids: null },
  "u-viewer": { role: "viewer", sede_ids: ["s1"] },
};
const OV = [{ fecha: WEEK, franja: "08:00", value: 5 }];

async function withApp(opts, fn) {
  const ctx = makeDeps(opts);
  const router = createSugeridoRouter({
    authenticate: createAuthenticate({ verifyToken: async (t) => (USERS[t] ? { id: USERS[t], email: `${USERS[t]}@x.co` } : null) }),
    accessRepo: { findByUserId: async (id) => ACCESS[id] ?? null },
    service: createSugeridoService(ctx.deps),
  });
  const server = createApp({ routes: createRoutes({ modules: { "/sugerido": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/sugerido`;
  const call = async (method, path, token, json) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ ...ctx, call });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const weekPath = (sede = "s1", week = WEEK) => `/sedes/${sede}/weeks/${week}`;
const ENDPOINTS = [["GET", "/sedes"], ["GET", weekPath()], ["POST", `${weekPath()}/runs`], ["PUT", `${weekPath()}/overrides`, OV]];

test("authentication: 401 without a valid token; 403 FORBIDDEN_ROLE without an access row", () =>
  withApp({}, async ({ call }) => {
    for (const [m, p, b] of ENDPOINTS) {
      assert.equal((await call(m, p, null, b)).status, 401, `${m} ${p}`);
      assert.equal((await call(m, p, "bogus", b)).status, 401, `${m} ${p} bogus`);
      const r = await call(m, p, "t-norole", b);
      assert.deepEqual([r.status, r.json.code], [403, "FORBIDDEN_ROLE"], `${m} ${p} norole`);
    }
  }));

test("viewer is read-only: reads 200, writes 403 even with an invalid body, nothing persisted", () =>
  withApp({}, async ({ call, repo }) => {
    assert.equal((await call("GET", "/sedes", "t-viewer")).status, 200);
    assert.equal((await call("GET", weekPath(), "t-viewer")).status, 200);
    for (const [m, p, b] of [["POST", `${weekPath()}/runs`], ["PUT", `${weekPath()}/overrides`, OV], ["PUT", `${weekPath()}/overrides`, {}], ["POST", `${weekPath("s1", "2026-11-24")}/runs`]]) {
      const r = await call(m, p, "t-viewer", b);
      assert.deepEqual([r.status, r.json.code], [403, "FORBIDDEN_ROLE"], `${m} ${p}`);
    }
    assert.equal(repo.calls.saveRun.length + repo.calls.applyOverrides.length, 0);
  }));

test("sede scoping: another sede is 403 FORBIDDEN_SEDE on every sede endpoint, no data leaked", () =>
  withApp({}, async ({ call, calls }) => {
    for (const [m, p, b] of [["GET", weekPath("s2")], ["POST", `${weekPath("s2")}/runs`], ["PUT", `${weekPath("s2")}/overrides`, OV]]) {
      const r = await call(m, p, "t-planner", b);
      assert.deepEqual([r.status, r.json.code], [403, "FORBIDDEN_SEDE"], `${m} ${p}`);
    }
    assert.equal((await call("GET", weekPath("s2"), "t-viewer")).status, 403);
    assert.equal(calls.sales.length, 0);
    assert.equal((await call("GET", weekPath("s2"), "t-planner-all")).status, 200);
    assert.equal((await call("GET", weekPath("s2"), "t-admin")).status, 200);
  }));

test("validation precedes the sede check: bad week or body is 400 even for a forbidden sede", () =>
  withApp({}, async ({ call, repo }) => {
    const bad = [
      ["GET", weekPath("s2", "2026-11-24")], ["POST", `${weekPath("s2", "2026-11-22")}/runs`], ["PUT", `${weekPath("s2", "2026-11-24")}/overrides`, OV],
      ["PUT", `${weekPath("s2")}/overrides`, []], ["PUT", `${weekPath("s2")}/overrides`, { fecha: WEEK }],
      ["PUT", `${weekPath("s2")}/overrides`, [{ fecha: "2026-11-30", franja: "08:00", value: 1 }]],
      ["PUT", `${weekPath("s2")}/overrides`, [{ fecha: WEEK, franja: "08:10", value: 1 }]],
      ["PUT", `${weekPath("s2")}/overrides`, [{ fecha: WEEK, franja: "08:00", value: -1 }]],
      ["PUT", `${weekPath("s2")}/overrides`, [...OV, ...OV]],
    ];
    for (const [m, p, b] of bad) {
      const r = await call(m, p, "t-planner", b);
      assert.deepEqual([r.status, r.json.code], [400, "VALIDATION_ERROR"], `${m} ${p} ${JSON.stringify(b)}`);
    }
    assert.equal(repo.calls.applyOverrides.length, 0);
  }));

test("GET /sedes: admin and all-sedes callers see every active sede, scoped callers only theirs", () =>
  withApp({}, async ({ call }) => {
    const ids = async (t) => (await call("GET", "/sedes", t)).json.data.map((s) => s.sedeId);
    assert.deepEqual(await ids("t-admin"), ["s1", "s2"]);
    assert.deepEqual(await ids("t-planner-all"), ["s1", "s2"]);
    assert.deepEqual(await ids("t-planner"), ["s1"]);
    assert.deepEqual(await ids("t-viewer"), ["s1"]);
  }));

test("unmapped or inactive sede -> 404 SEDE_NOT_MAPPED on read, run and overrides", () =>
  withApp({}, async ({ call }) => {
    for (const sede of ["nope", "s3"]) {
      for (const [m, p, b] of [["GET", weekPath(sede)], ["POST", `${weekPath(sede)}/runs`], ["PUT", `${weekPath(sede)}/overrides`, OV]]) {
        const r = await call(m, p, "t-admin", b);
        assert.deepEqual([r.status, r.json.code], [404, "SEDE_NOT_MAPPED"], `${m} ${sede}`);
      }
    }
  }));

test("GET before any run is a 200 empty state; POST runs is 201 and then GET returns the week", () =>
  withApp({}, async ({ call }) => {
    const empty = await call("GET", weekPath(), "t-planner");
    assert.deepEqual([empty.status, empty.json.data.run, empty.json.data.days], [200, null, []]);

    const created = await call("POST", `${weekPath()}/runs`, "t-planner");
    assert.equal(created.status, 201);
    assert.equal(created.json.data.run.version, 1);

    const week = (await call("GET", weekPath(), "t-viewer")).json.data;
    assert.equal(week.days.length, 7);
    assert.deepEqual([week.days[0].slots[0].suggested, week.days[0].slots[0].final], [3, 3]);
    assert.equal(week.freshness.stale, false);
  }));

test("overrides PUT: planner writes, recompute keeps them, null removes and restores the suggestion", () =>
  withApp({}, async ({ call, repo }) => {
    await call("POST", `${weekPath()}/runs`, "t-planner");
    const put = await call("PUT", `${weekPath()}/overrides`, "t-planner", OV);
    assert.equal(put.status, 200);
    assert.equal(repo.calls.applyOverrides[0].userId, "u-planner");
    assert.deepEqual([put.json.data.days[0].slots[0].override, put.json.data.days[0].slots[0].final], [5, 5]);

    const rerun = await call("POST", `${weekPath()}/runs`, "t-planner-all");
    assert.equal(rerun.json.data.run.version, 2);
    assert.deepEqual([rerun.json.data.days[0].slots[0].override, rerun.json.data.days[0].slots[0].difference], [5, 2]);

    const removed = await call("PUT", `${weekPath()}/overrides`, "t-planner", [{ ...OV[0], value: null }]);
    assert.deepEqual([removed.json.data.days[0].slots[0].override, removed.json.data.days[0].slots[0].final], [null, 3]);
  }));

test("run edge cases: noHistory is 200 (not persisted) with zeros; noProductivity keeps required null", () =>
  withApp({ history: buildHistory({ from: "2026-01-02", to: "2026-01-01", dataAsOf: null, withProductivity: false }) }, async ({ call, state }) => {
    const none = await call("POST", `${weekPath()}/runs`, "t-planner");
    assert.equal(none.status, 200); // nothing was saved: 201 is reserved for persisted runs
    assert.deepEqual([none.json.data.run.persisted, none.json.data.flags.noHistory, none.json.data.days[0].forecast.docs, none.json.data.freshness.stale], [false, true, 0, true]);

    state.history = buildHistory({ withProductivity: false });
    const noProd = await call("POST", `${weekPath()}/runs`, "t-planner");
    assert.deepEqual([noProd.json.data.flags.noProductivity, noProd.json.data.days[0].slots[0].required], [true, null]);
  }));

test("stale notice appears at read time when the clock moves, without a new run", () =>
  withApp({}, async ({ call, state }) => {
    await call("POST", `${weekPath()}/runs`, "t-planner");
    state.now = new Date("2026-11-25T15:00:00Z");
    const week = (await call("GET", weekPath(), "t-viewer")).json.data;
    assert.equal(week.freshness.stale, true);
    assert.match(week.freshness.notice, /5 days old/);
    assert.equal(week.run.version, 1);
  }));

test("upstream failures map to their status: staff 503, sales 503, sales timeout 504; nothing saved", () =>
  withApp({}, async ({ call, state, repo }) => {
    state.pool = createHttpError(503, "Employee directory is temporarily unavailable", "STAFF_SOURCE_UNAVAILABLE");
    let r = await call("POST", `${weekPath()}/runs`, "t-planner");
    assert.deepEqual([r.status, r.json.code], [503, "STAFF_SOURCE_UNAVAILABLE"]);

    state.pool = ["1001001"];
    state.history = createHttpError(503, "down", "SALES_DB_UNAVAILABLE");
    r = await call("POST", `${weekPath()}/runs`, "t-planner");
    assert.deepEqual([r.status, r.json.code], [503, "SALES_DB_UNAVAILABLE"]);

    state.history = Object.assign(new Error("canceling statement"), { code: "57014" });
    r = await call("POST", `${weekPath()}/runs`, "t-planner");
    assert.deepEqual([r.status, r.json.code], [504, "SALES_DB_TIMEOUT"]);
    assert.equal(repo.calls.saveRun.length, 0);
  }));

test("PUT overrides on a week without a persisted run -> 409 NO_RUN", () =>
  withApp({}, async ({ call, repo }) => {
    const r = await call("PUT", `${weekPath()}/overrides`, "t-planner", OV);
    assert.deepEqual([r.status, r.json.code], [409, "NO_RUN"]);
    assert.equal(repo.calls.applyOverrides.length, 0);
  }));

test("a week outside the allowed window is 400 WEEK_OUT_OF_RANGE on read, run and overrides", () =>
  withApp({}, async ({ call, repo }) => {
    const far = "2030-01-07"; // Monday, years past the 12-week horizon
    for (const [method, path, body] of [["GET", weekPath("s1", far)], ["POST", `${weekPath("s1", far)}/runs`], ["PUT", `${weekPath("s1", far)}/overrides`, [{ fecha: far, franja: "08:00", value: 1 }]]]) {
      const r = await call(method, path, "t-planner", body);
      assert.deepEqual([r.status, r.json.code, r.json.error], [400, "WEEK_OUT_OF_RANGE", "La semana está fuera del rango permitido."], method);
    }
    assert.deepEqual([repo.calls.saveRun.length, repo.calls.applyOverrides.length], [0, 0]);
  }));
