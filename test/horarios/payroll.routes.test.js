import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createHttpError } = await import("../../src/shared/http/HttpError.js");
const { createPayrollRouter } = await import("../../src/modules/horarios/payroll.routes.js");

const U = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const ADMIN = U("1"), PLANNER = U("2"), VIEWER = U("3"), STRANGER = U("4");
const TOKENS = { "t-admin": ADMIN, "t-planner": PLANNER, "t-viewer": VIEWER, "t-stranger": STRANGER };
const ROWS = {
  [ADMIN]: { role: "admin", sede_ids: null },
  [PLANNER]: { role: "planner", sede_ids: ["copacabana"] },
  [VIEWER]: { role: "viewer", sede_ids: ["copacabana"] },
};

function stubService(impl) {
  const calls = [];
  return { calls, async report(access, query) { calls.push([access, query]); return impl ? impl(access, query) : { source: "live", rows: [] }; } };
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
  const call = async (path, token) => {
    const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ call, service });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const Q = "/report?from=2026-10-26&to=2026-11-08";

test("401 without a token or with an invalid one", () =>
  withApp(async ({ call, service }) => {
    assert.equal((await call(Q, null)).status, 401);
    assert.equal((await call(Q, "bogus")).status, 401);
    assert.equal(service.calls.length, 0);
  }));

test("403 for users without an access row and for viewers (payroll is sensitive)", () =>
  withApp(async ({ call, service }) => {
    assert.equal((await call(Q, "t-stranger")).status, 403);
    const viewer = await call(Q, "t-viewer");
    assert.equal(viewer.status, 403);
    assert.equal(viewer.json.code, "FORBIDDEN_ROLE");
    assert.equal(service.calls.length, 0);
  }));

test("a planner asking for another sede gets 403 FORBIDDEN_SEDE before the service runs", () =>
  withApp(async ({ call, service }) => {
    const res = await call(`${Q}&sedeId=bello`, "t-planner");
    assert.equal(res.status, 403);
    assert.equal(res.json.code, "FORBIDDEN_SEDE");
    assert.equal(service.calls.length, 0);
    assert.equal((await call(`${Q}&sedeId=copacabana`, "t-planner")).status, 200);
  }));

test("an empty sedeId is rejected with 400 VALIDATION_ERROR", () =>
  withApp(async ({ call }) => {
    const res = await call(`${Q}&sedeId=`, "t-admin");
    assert.equal(res.status, 400);
    assert.equal(res.json.code, "VALIDATION_ERROR");
  }));

test("admin and planner get 200 and the service receives their access and the parsed query", () =>
  withApp(async ({ call, service }) => {
    const admin = await call(Q, "t-admin");
    assert.equal(admin.status, 200);
    assert.equal(admin.json.source, "live");
    assert.deepEqual(service.calls[0], [{ role: "admin", sedeIds: null }, { from: "2026-10-26", to: "2026-11-08" }]);
    assert.equal((await call("/report", "t-planner")).status, 200);
    assert.deepEqual(service.calls[1], [{ role: "planner", sedeIds: ["copacabana"] }, {}]);
  }));

test("service errors keep their status and stable code (PAYROLL_PERIOD_INVALID -> 400)", () =>
  withApp(
    async ({ call }) => {
      const res = await call("/report?from=2026-10-27&to=2026-11-09", "t-admin");
      assert.equal(res.status, 400);
      assert.equal(res.json.code, "PAYROLL_PERIOD_INVALID");
    },
    stubService(() => { throw createHttpError(400, "El corte debe ser de 1 o 2 semanas completas, de lunes a domingo.", "PAYROLL_PERIOD_INVALID"); }),
  ));

test("default wiring rejects an anonymous /api/horarios/payroll/report with 401 (no network needed)", async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/horarios/payroll/report`);
    assert.equal(res.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
