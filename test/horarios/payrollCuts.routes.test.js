import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createHttpError } = await import("../../src/shared/http/HttpError.js");
const { createPayrollRouter } = await import("../../src/modules/horarios/payroll.routes.js");

const U = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const ADMIN = U("1"), PLANNER = U("2"), VIEWER = U("3");
const TOKENS = { "t-admin": ADMIN, "t-planner": PLANNER, "t-viewer": VIEWER };
const ROWS = {
  [ADMIN]: { role: "admin", sede_ids: null },
  [PLANNER]: { role: "planner", sede_ids: ["copacabana"] },
  [VIEWER]: { role: "viewer", sede_ids: ["copacabana"] },
};

function stubService(overrides = {}) {
  const calls = [];
  const record = (name, result) => async (...args) => {
    calls.push([name, ...args]);
    return typeof result === "function" ? result(...args) : result;
  };
  return {
    calls,
    report: record("report", { source: "live" }),
    listCuts: record("listCuts", { items: [], lastPaid: null, nextDefaultFrom: "2026-08-31" }),
    getCut: record("getCut", { source: "cut" }),
    saveCut: record("saveCut", { cut: { id: 7 } }),
    voidCut: record("voidCut", { cut: { id: 7, state: "ANULADO" } }),
    ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, record(k, v)])),
  };
}

async function withApp(fn, service = stubService()) {
  const router = createPayrollRouter({
    authenticate: createAuthenticate({ verifyToken: async (t) => (TOKENS[t] ? { id: TOKENS[t], email: "x@x.co" } : null) }),
    accessRepo: { async findByUserId(id) { return ROWS[id] ? { user_id: id, ...ROWS[id], revoked_at: null } : null; } },
    service,
  });
  const server = createApp({ routes: createRoutes({ modules: { "/horarios/payroll": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/horarios/payroll`;
  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ call, service });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const SAVE = { from: "2026-10-26", to: "2026-11-08", fingerprint: "abc" };

test("401 without a token on every cut route", () =>
  withApp(async ({ call, service }) => {
    for (const [m, p, b] of [["GET", "/cuts"], ["GET", "/cuts/7"], ["POST", "/cuts", null, SAVE], ["POST", "/cuts/7/void", null, {}]]) {
      assert.equal((await call(m, p, null, b)).status, 401, `${m} ${p}`);
    }
    assert.equal(service.calls.length, 0);
  }));

test("viewers are denied everywhere; planners can read but not save or void", () =>
  withApp(async ({ call, service }) => {
    assert.equal((await call("GET", "/cuts", "t-viewer")).status, 403);
    assert.equal((await call("GET", "/cuts/7", "t-viewer")).status, 403);
    assert.equal((await call("POST", "/cuts", "t-viewer", SAVE)).status, 403);
    const save = await call("POST", "/cuts", "t-planner", SAVE);
    assert.deepEqual([save.status, save.json.code], [403, "FORBIDDEN_ROLE"]);
    const voided = await call("POST", "/cuts/7/void", "t-planner", {});
    assert.deepEqual([voided.status, voided.json.code], [403, "FORBIDDEN_ROLE"]);
    assert.equal(service.calls.length, 0);
    assert.equal((await call("GET", "/cuts", "t-planner")).status, 200);
    assert.equal((await call("GET", "/cuts/7", "t-planner")).status, 200);
  }));

test("GET /cuts forwards the access and the validated limit", () =>
  withApp(async ({ call, service }) => {
    const res = await call("GET", "/cuts?limit=5", "t-admin");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { items: [], lastPaid: null, nextDefaultFrom: "2026-08-31" });
    assert.deepEqual(service.calls[0], ["listCuts", { role: "admin", sedeIds: null }, { limit: 5 }]);
    await call("GET", "/cuts", "t-admin");
    assert.deepEqual(service.calls[1], ["listCuts", { role: "admin", sedeIds: null }, {}]);
    for (const bad of ["0", "201", "abc", "1.5"]) {
      const r = await call("GET", `/cuts?limit=${bad}`, "t-admin");
      assert.deepEqual([r.status, r.json.code], [400, "VALIDATION_ERROR"], bad);
    }
    assert.equal(service.calls.length, 2);
  }));

test("GET /cuts/:id validates the id, scopes sedeId for planners and forwards a numeric id", () =>
  withApp(async ({ call, service }) => {
    assert.equal((await call("GET", "/cuts/7", "t-admin")).status, 200);
    assert.deepEqual(service.calls[0], ["getCut", { role: "admin", sedeIds: null }, 7, {}]);
    assert.equal((await call("GET", "/cuts/7?sedeId=copacabana", "t-planner")).status, 200);
    assert.deepEqual(service.calls[1], ["getCut", { role: "planner", sedeIds: ["copacabana"] }, 7, { sedeId: "copacabana" }]);
    const foreign = await call("GET", "/cuts/7?sedeId=bello", "t-planner");
    assert.deepEqual([foreign.status, foreign.json.code], [403, "FORBIDDEN_SEDE"]);
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      assert.equal((await call("GET", `/cuts/${bad}`, "t-admin")).status, 400, bad);
    }
    assert.equal((await call("GET", "/cuts/7?sedeId=", "t-admin")).status, 400);
    assert.equal(service.calls.length, 2);
  }));

test("POST /cuts (admin) answers 201 and the service receives only the validated body", () =>
  withApp(async ({ call, service }) => {
    const res = await call("POST", "/cuts", "t-admin", { ...SAVE, dominicales: 99, rows: [] });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json, { cut: { id: 7 } });
    const [name, access, user, body] = service.calls[0];
    assert.equal(name, "saveCut");
    assert.deepEqual(access, { role: "admin", sedeIds: null });
    assert.equal(user.id, ADMIN);
    assert.deepEqual(body, SAVE, "client numbers are stripped");
  }));

test("POST /cuts validates the body: from, to and the report fingerprint are required", () =>
  withApp(async ({ call, service }) => {
    for (const body of [{}, { from: SAVE.from, to: SAVE.to }, { from: SAVE.from, fingerprint: "a" }, { ...SAVE, fingerprint: "" }, { ...SAVE, from: 5 }]) {
      const r = await call("POST", "/cuts", "t-admin", body);
      assert.deepEqual([r.status, r.json.code], [400, "VALIDATION_ERROR"], JSON.stringify(body));
    }
    assert.equal(service.calls.length, 0);
  }));

test("POST /cuts/:id/void (admin) forwards id and the optional reason", () =>
  withApp(async ({ call, service }) => {
    const res = await call("POST", "/cuts/7/void", "t-admin", { reason: "  typo  " });
    assert.equal(res.status, 200);
    assert.equal(res.json.cut.state, "ANULADO");
    const [name, access, user, id, body] = service.calls[0];
    assert.deepEqual([name, access.role, user.id, id, body], ["voidCut", "admin", ADMIN, 7, { reason: "typo" }]);
    await call("POST", "/cuts/7/void", "t-admin", {});
    assert.deepEqual(service.calls[1][4], {}, "the reason is optional");
    assert.equal((await call("POST", "/cuts/7/void", "t-admin")).status, 200, "no body at all");
    assert.equal((await call("POST", "/cuts/7/void", "t-admin", { reason: "x".repeat(501) })).status, 400);
    assert.equal((await call("POST", "/cuts/abc/void", "t-admin", {})).status, 400);
  }));

test("service errors keep their status, stable code and details", () =>
  withApp(
    async ({ call }) => {
      const res = await call("POST", "/cuts", "t-admin", SAVE);
      assert.equal(res.status, 409);
      assert.equal(res.json.code, "PAYROLL_CUT_OVERLAP");
      assert.deepEqual(res.json.details, { cut: { id: 3, from: "2026-10-19", to: "2026-11-01" } });
    },
    stubService({
      saveCut: () => {
        const err = createHttpError(409, "Ya existe un corte pagado que se cruza con este periodo.", "PAYROLL_CUT_OVERLAP");
        err.details = { cut: { id: 3, from: "2026-10-19", to: "2026-11-01" } };
        throw err;
      },
    }),
  ));

test("src/routes.js hands the profiles repository to the payroll service (names of who saved or voided)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/routes.js", import.meta.url), "utf8");
  const mount = src.slice(src.indexOf('"/horarios/payroll":'), src.indexOf('"/horarios":'));
  assert.match(mount, /createPayrollService\(\{[^}]*profilesRepo: createProfilesRepo\(lazyClient\)/s);
});
