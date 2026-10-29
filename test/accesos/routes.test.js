import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createHttpError } = await import("../../src/shared/http/HttpError.js");
const { createAccesosRouter } = await import("../../src/modules/accesos/accesos.routes.js");
const { createAccesosService } = await import("../../src/modules/accesos/accesos.service.js");

const U = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
// Users
const ADMIN = U("1"), ADMIN2 = U("2"), PLANNER = U("3"), VIEWER = U("4"), TARGET = U("5"), GHOST = U("9");
// Access row ids
const ROW_ADMIN = U("6"), ROW_PLANNER = U("7"), ROW_VIEWER = U("b"), ROW_ADMIN2 = U("c"), ROW_UNKNOWN = U("d");
const TOKENS = { "t-admin": ADMIN, "t-admin2": ADMIN2, "t-planner": PLANNER, "t-viewer": VIEWER, "t-stranger": U("8") };
const PROFILES = [
  { user_id: VIEWER, nombre: "Vera Viewer", correo: "vera@x.co" },
  { user_id: PLANNER, nombre: "Paula Planner", correo: "paula@x.co" },
  { user_id: ADMIN, nombre: "Ana Admin", correo: "ana@x.co", role: "super_admin", telefono: "300" },
  { user_id: TARGET, nombre: "Juan Perez", correo: "juan@x.co", role: "x", telefono: "301", proceso: "p" },
];
const SEDES = ["s1", "s2"];

// Fakes follow spec R8 (one active row per user, soft revoke, last-admin protection), written
// independently of the implementation. Rows use the sugerido_access column names.
function fakes() {
  let n = 0;
  const base = { created_by: null, created_at: "t0", updated_by: null, updated_at: "t0", revoked_by: null, revoked_at: null };
  const rows = [
    { id: ROW_ADMIN, user_id: ADMIN, role: "admin", sede_ids: null },
    { id: ROW_PLANNER, user_id: PLANNER, role: "planner", sede_ids: ["s1"] },
    { id: ROW_VIEWER, user_id: VIEWER, role: "viewer", sede_ids: ["s1"] },
  ].map((r) => ({ ...base, ...r }));
  const active = (r) => !r.revoked_at;
  const otherAdmins = (id) => rows.filter((r) => active(r) && r.role === "admin" && r.id !== id).length;
  const calls = [];
  const accessRepo = {
    rows,
    calls,
    async findByUserId(userId) {
      return rows.find((r) => r.user_id === userId && active(r)) ?? null;
    },
    async list({ incluirRevocados }) {
      return rows.filter((r) => incluirRevocados || active(r));
    },
    async findById(id) {
      return rows.find((r) => r.id === id && active(r)) ?? null;
    },
    async findExistingSedeIds(ids) {
      return ids.filter((i) => SEDES.includes(i));
    },
    async create({ userId, role, sedeIds, actor }) {
      calls.push(["create", { userId, role, sedeIds, actor }]);
      if (rows.some((r) => r.user_id === userId && active(r))) throw createHttpError(409, "dup", "DUPLICATE_ACCESS");
      const row = { ...base, id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`, user_id: userId, role, sede_ids: sedeIds, created_by: actor, updated_by: actor };
      rows.push(row);
      return row;
    },
    async update({ id, role, sedeIds, actor }) {
      calls.push(["update", { id, role, sedeIds, actor }]);
      const row = rows.find((r) => r.id === id && active(r));
      if (!row) throw createHttpError(404, "nf", "ACCESS_NOT_FOUND");
      if (row.role === "admin" && role !== "admin" && !otherAdmins(id)) throw createHttpError(409, "last", "LAST_ADMIN");
      Object.assign(row, { role, sede_ids: sedeIds, updated_by: actor });
      return row;
    },
    async revoke({ id, actor }) {
      calls.push(["revoke", { id, actor }]);
      const row = rows.find((r) => r.id === id && active(r));
      if (!row) throw createHttpError(404, "nf", "ACCESS_NOT_FOUND");
      if (row.role === "admin" && !otherAdmins(id)) throw createHttpError(409, "last", "LAST_ADMIN");
      Object.assign(row, { revoked_at: "t2", revoked_by: actor, updated_by: actor });
      return row;
    },
  };
  const slim = (p) => ({ user_id: p.user_id, nombre: p.nombre, correo: p.correo });
  const profilesRepo = {
    async findById(userId) {
      const p = PROFILES.find((x) => x.user_id === userId);
      return p ? slim(p) : null;
    },
    async search(q, limit) {
      return PROFILES.filter((p) => `${p.nombre} ${p.correo}`.toLowerCase().includes(q.toLowerCase()))
        .slice(0, limit)
        .map(slim);
    },
  };
  return { accessRepo, profilesRepo };
}

async function start() {
  const { accessRepo, profilesRepo } = fakes();
  const router = createAccesosRouter({
    authenticate: createAuthenticate({ verifyToken: async (t) => (TOKENS[t] ? { id: TOKENS[t], email: "x@x.co" } : null) }),
    accessRepo,
    service: createAccesosService({ repo: accessRepo, profilesRepo }),
  });
  const server = createApp({ routes: createRoutes({ modules: { "/accesos": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/accesos`;
  const call = async (method, path, token, json) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { accessRepo, call, close: () => new Promise((r) => server.close(r)) };
}
async function withApp(fn) {
  const app = await start();
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

const VALID = { userId: TARGET, role: "viewer", sedeIds: ["s1"] };
const ALL = [
  ["GET", "/"],
  ["POST", "/", VALID],
  ["PATCH", `/${ROW_PLANNER}`, { role: "viewer" }],
  ["POST", `/${ROW_PLANNER}/revocar`],
  ["GET", "/usuarios?q=jua"],
];

test("401 without token or with an invalid one on every endpoint", () =>
  withApp(async ({ call }) => {
    for (const [m, p, b] of ALL) {
      assert.equal((await call(m, p, null, b)).status, 401, `${m} ${p}`);
      assert.equal((await call(m, p, "bogus", b)).status, 401, `${m} ${p} bogus`);
    }
  }));

test("403 for planner, viewer and users without an access row on every endpoint (R8.1)", () =>
  withApp(async ({ call, accessRepo }) => {
    for (const token of ["t-planner", "t-viewer", "t-stranger"]) {
      for (const [m, p, b] of ALL) assert.equal((await call(m, p, token, b)).status, 403, `${token} ${m} ${p}`);
    }
    assert.equal(accessRepo.calls.length, 0, "no write reached the repository");
  }));

test("403 for an admin whose own row was revoked", () =>
  withApp(async ({ call, accessRepo }) => {
    accessRepo.rows.find((r) => r.user_id === ADMIN).revoked_at = "t";
    assert.equal((await call("GET", "/", "t-admin")).status, 403);
  }));

test("list: admin sees active rows as camelCase DTOs; revoked excluded unless incluirRevocados=true", () =>
  withApp(async ({ call, accessRepo }) => {
    accessRepo.rows.find((r) => r.user_id === VIEWER).revoked_at = "t";
    const r = await call("GET", "/", "t-admin");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.map((x) => x.userId).sort(), [ADMIN, PLANNER].sort());
    assert.deepEqual(Object.keys(r.json.data[0]).sort(), ["createdAt", "createdBy", "id", "revokedAt", "revokedBy", "role", "sedeIds", "updatedAt", "updatedBy", "userId"]);
    const all = await call("GET", "/?incluirRevocados=true", "t-admin");
    assert.equal(all.json.data.length, 3);
  }));

test("create: 201 with audit from the authenticated user, never from the body (R8.6)", () =>
  withApp(async ({ call, accessRepo }) => {
    const r = await call("POST", "/", "t-admin", { ...VALID, createdBy: "evil", actor: "evil" });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.userId, TARGET);
    assert.equal(r.json.data.createdBy, ADMIN);
    assert.deepEqual(accessRepo.calls[0], ["create", { userId: TARGET, role: "viewer", sedeIds: ["s1"], actor: ADMIN }]);
  }));

test("create: sedeIds null (all sedes) is accepted", () =>
  withApp(async ({ call }) => {
    const r = await call("POST", "/", "t-admin", { ...VALID, sedeIds: null });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.sedeIds, null);
  }));

test("create: 409 DUPLICATE_ACCESS when the user already has an active row", () =>
  withApp(async ({ call }) => {
    const r = await call("POST", "/", "t-admin", { ...VALID, userId: PLANNER });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "DUPLICATE_ACCESS");
  }));

test("create: 400 for unknown user (USER_NOT_FOUND), unknown sede (SEDE_NOT_FOUND), invalid role; nothing persisted", () =>
  withApp(async ({ call, accessRepo }) => {
    const ghost = await call("POST", "/", "t-admin", { ...VALID, userId: GHOST });
    assert.equal(ghost.status, 400);
    assert.equal(ghost.json.code, "USER_NOT_FOUND");
    const sede = await call("POST", "/", "t-admin", { ...VALID, sedeIds: ["s1", "nope"] });
    assert.equal(sede.status, 400);
    assert.equal(sede.json.code, "SEDE_NOT_FOUND");
    assert.equal((await call("POST", "/", "t-admin", { ...VALID, role: "owner" })).status, 400);
    assert.equal((await call("POST", "/", "t-admin", { ...VALID, sedeIds: [] })).status, 400);
    assert.equal(accessRepo.calls.length, 0);
  }));

test("update: changes role and scope, merging omitted fields from the current row", () =>
  withApp(async ({ call, accessRepo }) => {
    const r = await call("PATCH", `/${ROW_PLANNER}`, "t-admin", { role: "viewer" });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.role, "viewer");
    assert.deepEqual(r.json.data.sedeIds, ["s1"]);
    assert.equal(r.json.data.updatedBy, ADMIN);
    const s = await call("PATCH", `/${ROW_PLANNER}`, "t-admin", { sedeIds: null });
    assert.equal(s.json.data.sedeIds, null);
    assert.equal(s.json.data.role, "viewer");
    assert.equal(accessRepo.calls.length, 2);
  }));

test("update: 404 unknown row, 400 unknown sede / empty body / bad id", () =>
  withApp(async ({ call }) => {
    assert.equal((await call("PATCH", `/${ROW_UNKNOWN}`, "t-admin", { role: "viewer" })).status, 404);
    const sede = await call("PATCH", `/${ROW_PLANNER}`, "t-admin", { sedeIds: ["zz"] });
    assert.equal(sede.status, 400);
    assert.equal(sede.json.code, "SEDE_NOT_FOUND");
    assert.equal((await call("PATCH", `/${ROW_PLANNER}`, "t-admin", {})).status, 400);
    assert.equal((await call("PATCH", "/not-a-uuid", "t-admin", { role: "viewer" })).status, 400);
  }));

test("last admin: demote and revoke -> 409 LAST_ADMIN, row unchanged", () =>
  withApp(async ({ call, accessRepo }) => {
    const d = await call("PATCH", `/${ROW_ADMIN}`, "t-admin", { role: "planner" });
    assert.equal(d.status, 409);
    assert.equal(d.json.code, "LAST_ADMIN");
    const rv = await call("POST", `/${ROW_ADMIN}/revocar`, "t-admin");
    assert.equal(rv.status, 409);
    assert.equal(rv.json.code, "LAST_ADMIN");
    const row = accessRepo.rows.find((r) => r.id === ROW_ADMIN);
    assert.equal(row.role, "admin");
    assert.equal(row.revoked_at, null);
  }));

test("self-downgrade is allowed when another active admin exists (R8.4)", () =>
  withApp(async ({ call, accessRepo }) => {
    accessRepo.rows.push({ id: ROW_ADMIN2, user_id: ADMIN2, role: "admin", sede_ids: null, revoked_at: null });
    const r = await call("PATCH", `/${ROW_ADMIN}`, "t-admin", { role: "viewer", sedeIds: ["s1"] });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.role, "viewer");
    // admin2 is now the last admin and cannot downgrade itself.
    const again = await call("PATCH", `/${ROW_ADMIN2}`, "t-admin2", { role: "viewer" });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, "LAST_ADMIN");
  }));

test("revoke: soft revoke with audit; access lost immediately; revoking twice -> 404", () =>
  withApp(async ({ call, accessRepo }) => {
    const r = await call("POST", `/${ROW_PLANNER}/revocar`, "t-admin");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.revokedBy, ADMIN);
    assert.ok(r.json.data.revokedAt);
    assert.ok(accessRepo.rows.some((x) => x.id === ROW_PLANNER), "row kept for audit");
    assert.equal((await call("GET", "/", "t-planner")).status, 403);
    assert.equal((await call("POST", `/${ROW_PLANNER}/revocar`, "t-admin")).status, 404);
  }));

test("a revoked user can be granted access again (one ACTIVE row per user)", () =>
  withApp(async ({ call, accessRepo }) => {
    accessRepo.rows.find((r) => r.user_id === VIEWER).revoked_at = "t";
    const r = await call("POST", "/", "t-admin", { ...VALID, userId: VIEWER });
    assert.equal(r.status, 201);
  }));

test("lookup is capped at 20 results, both in the query and in the response", async () => {
  let askedLimit;
  const many = Array.from({ length: 30 }, (_, i) => ({ user_id: `u${i}`, nombre: `N${i}`, correo: `c${i}@x.co` }));
  const service = createAccesosService({
    repo: {},
    profilesRepo: { search: async (_q, limit) => ((askedLimit = limit), many) },
  });
  const { data } = await service.searchUsers("juan");
  assert.equal(askedLimit, 20);
  assert.equal(data.length, 20);
});

test("lookup: returns only userId, nombre, correo; no other profile field leaks (R8.5)", () =>
  withApp(async ({ call }) => {
    const r = await call("GET", "/usuarios?q=juan", "t-admin");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, [{ userId: TARGET, nombre: "Juan Perez", correo: "juan@x.co" }]);
    assert.equal((await call("GET", "/usuarios?q=j", "t-admin")).status, 400);
    assert.equal((await call("GET", "/usuarios", "t-admin")).status, 400);
  }));
