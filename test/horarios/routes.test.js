import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createHttpError } = await import("../../src/shared/http/HttpError.js");
const { createHorariosRouter } = await import("../../src/modules/horarios/horarios.routes.js");

const U = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const ADMIN = U("1"), PLANNER = U("2"), VIEWER = U("3"), STRANGER = U("4");
const TOKENS = { "t-admin": ADMIN, "t-planner": PLANNER, "t-viewer": VIEWER, "t-stranger": STRANGER };
const ROWS = {
  [ADMIN]: { role: "admin", sede_ids: null },
  [PLANNER]: { role: "planner", sede_ids: ["copacabana"] },
  [VIEWER]: { role: "viewer", sede_ids: ["copacabana"] },
};
const W = "2031-01-06";
const SHIFT = { cedula: "11111111", fecha: W, tipo: "TRABAJO", startTime: "08:00", endTime: "17:00" };
const SAVE = { expectedVersion: 0, cedulas: ["11111111"], shifts: [SHIFT] };

function stubService() {
  const calls = [];
  const rec = (name, result) => async (...args) => (calls.push([name, ...args]), result);
  return {
    calls,
    get: rec("get", { schedule: {}, shifts: [], permissions: { canEdit: true, canPublish: true } }),
    save: rec("save", { schedule: {}, shifts: [], warnings: [] }),
    publish: rec("publish", { schedule: {}, warnings: [], alreadyPublished: false }),
    history: rec("history", { items: [] }),
  };
}

async function withApp(fn, service = stubService()) {
  const router = createHorariosRouter({
    authenticate: createAuthenticate({ verifyToken: async (t) => (TOKENS[t] ? { id: TOKENS[t], email: "x@x.co" } : null) }),
    accessRepo: { async findByUserId(id) { return ROWS[id] ? { user_id: id, ...ROWS[id], revoked_at: null } : null; } },
    service,
  });
  const server = createApp({ routes: createRoutes({ modules: { "/horarios": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/horarios`;
  const call = async (method, path, token, json) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ call, service });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const path = (suffix, sede = "copacabana", week = W) => `/sedes/${sede}/weeks/${week}/${suffix}`;
const ALL = [
  ["GET", path("shifts")],
  ["PUT", path("shifts"), SAVE],
  ["POST", path("publish"), { expectedVersion: 1 }],
  ["GET", path("history")],
];

test("401 without a token or with an invalid one on every endpoint", () =>
  withApp(async ({ call, service }) => {
    for (const [m, p, b] of ALL) {
      assert.equal((await call(m, p, null, b)).status, 401, `${m} ${p}`);
      assert.equal((await call(m, p, "bogus", b)).status, 401, `${m} ${p} bogus`);
    }
    assert.equal(service.calls.length, 0);
  }));

test("a user without an access row gets 403 on every endpoint", () =>
  withApp(async ({ call, service }) => {
    for (const [m, p, b] of ALL) assert.equal((await call(m, p, "t-stranger", b)).status, 403, `${m} ${p}`);
    assert.equal(service.calls.length, 0);
  }));

test("viewers can read and see history but cannot save or publish", () =>
  withApp(async ({ call, service }) => {
    assert.equal((await call("GET", path("shifts"), "t-viewer")).status, 200);
    assert.equal((await call("GET", path("history"), "t-viewer")).status, 200);
    const put = await call("PUT", path("shifts"), "t-viewer", SAVE);
    assert.equal(put.status, 403);
    assert.equal(put.json.code, "FORBIDDEN_ROLE");
    assert.equal((await call("POST", path("publish"), "t-viewer", { expectedVersion: 1 })).status, 403);
    assert.deepEqual(service.calls.map((c) => c[0]), ["get", "history"]);
  }));

test("a scoped user gets 403 FORBIDDEN_SEDE on another sede, for every endpoint", () =>
  withApp(async ({ call, service }) => {
    for (const [m, p, b] of ALL) {
      const res = await call(m, p.replace("copacabana", "las-vegas"), "t-planner", b);
      assert.equal(res.status, 403, `${m} ${p}`);
      assert.equal(res.json.code, "FORBIDDEN_SEDE");
    }
    assert.equal(service.calls.length, 0);
  }));

test("planners work on their sede and admins on any sede", () =>
  withApp(async ({ call, service }) => {
    assert.equal((await call("PUT", path("shifts"), "t-planner", SAVE)).status, 200);
    assert.equal((await call("POST", path("publish"), "t-planner", { expectedVersion: 1 })).status, 200);
    assert.equal((await call("PUT", path("shifts", "las-vegas"), "t-admin", SAVE)).status, 200);
    assert.deepEqual(service.calls.map((c) => [c[0], c[3], c[4]]), [["save", "copacabana", W], ["publish", "copacabana", W], ["save", "las-vegas", W]]);
  }));

test("the service receives the access, the user and the parsed body", () =>
  withApp(async ({ call, service }) => {
    await call("PUT", path("shifts"), "t-planner", { ...SAVE, extra: 1, shifts: [{ ...SHIFT, need: 4 }] });
    const [, access, user, sedeId, weekStart, body] = service.calls[0];
    assert.deepEqual(access, { role: "planner", sedeIds: ["copacabana"] });
    assert.equal(user.id, PLANNER);
    assert.deepEqual([sedeId, weekStart], ["copacabana", W]);
    assert.equal("extra" in body, false);
    assert.equal("need" in body.shifts[0], false);
  }));

test("history passes the parsed limit", () =>
  withApp(async ({ call, service }) => {
    await call("GET", path("history") + "?limit=7", "t-viewer");
    await call("GET", path("history"), "t-viewer");
    assert.deepEqual(service.calls.map((c) => c[4]), [7, 50]);
    assert.equal((await call("GET", path("history") + "?limit=500", "t-viewer")).status, 400);
  }));

test("validation: Tuesday weekStart, bad body, version 0 on publish are 400 VALIDATION_ERROR", () =>
  withApp(async ({ call, service }) => {
    for (const [m, p, b] of [
      ["GET", path("shifts", "copacabana", "2031-01-07")],
      ["PUT", path("shifts", "copacabana", "2031-01-07"), SAVE],
      ["PUT", path("shifts"), { ...SAVE, expectedVersion: -1 }],
      ["PUT", path("shifts"), { ...SAVE, cedulas: [] }],
      ["PUT", path("shifts"), { ...SAVE, shifts: [{ ...SHIFT, tipo: "VACACIONES" }] }],
      ["POST", path("publish"), { expectedVersion: 0 }],
    ]) {
      const res = await call(m, p, "t-admin", b);
      assert.equal(res.status, 400, `${m} ${p}`);
      assert.equal(res.json.code, "VALIDATION_ERROR");
    }
    assert.equal(service.calls.length, 0);
  }));

test("a forbidden role never learns about validation details", () =>
  withApp(async ({ call }) => {
    assert.equal((await call("PUT", path("shifts", "copacabana", "2031-01-07"), "t-viewer", { bad: true })).status, 403);
  }));

test("service errors keep their status, code and details", () => {
  const service = stubService();
  service.save = async () => {
    const e = createHttpError(409, "stale", "VERSION_CONFLICT");
    e.details = { currentVersion: 3 };
    throw e;
  };
  service.publish = async () => {
    const e = createHttpError(422, "blocked", "PUBLISH_BLOCKED");
    e.details = { blockers: [{ cedula: "11111111", code: "DESCANSO_SEMANAL_OBLIGATORIO" }] };
    throw e;
  };
  return withApp(async ({ call }) => {
    const a = await call("PUT", path("shifts"), "t-admin", SAVE);
    assert.deepEqual([a.status, a.json.code, a.json.details], [409, "VERSION_CONFLICT", { currentVersion: 3 }]);
    const b = await call("POST", path("publish"), "t-admin", { expectedVersion: 1 });
    assert.deepEqual([b.status, b.json.code], [422, "PUBLISH_BLOCKED"]);
    assert.equal(b.json.details.blockers.length, 1);
  }, service);
});
