import test from "node:test";
import assert from "node:assert/strict";

import { canAccessSede, loadAccess, requireRole, requireSede } from "../../src/shared/http/authorize.js";

// Runs a middleware and resolves with whatever it passed to next().
function run(mw, req) {
  return new Promise((resolve) => {
    const result = mw(req, {}, (err) => resolve(err));
    if (result && typeof result.catch === "function") result.catch(resolve);
  });
}

const repoOf = (row) => ({ findByUserId: async () => row });

test("loadAccess attaches role and sedeIds from the repository", async () => {
  const req = { user: { id: "u1" } };
  const err = await run(loadAccess(repoOf({ role: "planner", sede_ids: ["a", "b"] })), req);
  assert.equal(err, undefined);
  assert.deepEqual(req.access, { role: "planner", sedeIds: ["a", "b"] });
});

test("loadAccess keeps null sede_ids as unrestricted (null)", async () => {
  const req = { user: { id: "u1" } };
  await run(loadAccess(repoOf({ role: "admin", sede_ids: null })), req);
  assert.deepEqual(req.access, { role: "admin", sedeIds: null });
});

test("loadAccess queries by the authenticated user id", async () => {
  let seen;
  const repo = { findByUserId: async (id) => ((seen = id), { role: "viewer", sede_ids: [] }) };
  await run(loadAccess(repo), { user: { id: "user-42" } });
  assert.equal(seen, "user-42");
});

test("loadAccess: user without a row -> 403 FORBIDDEN_ROLE", async () => {
  const err = await run(loadAccess(repoOf(null)), { user: { id: "u1" } });
  assert.equal(err.statusCode, 403);
  assert.equal(err.code, "FORBIDDEN_ROLE");
});

test("loadAccess: unknown role value -> 403 FORBIDDEN_ROLE", async () => {
  const err = await run(loadAccess(repoOf({ role: "root", sede_ids: null })), { user: { id: "u1" } });
  assert.equal(err.code, "FORBIDDEN_ROLE");
});

test("loadAccess: missing req.user -> 401 AUTH_REQUIRED", async () => {
  const err = await run(loadAccess(repoOf({ role: "admin", sede_ids: null })), {});
  assert.equal(err.statusCode, 401);
  assert.equal(err.code, "AUTH_REQUIRED");
});

test("loadAccess forwards repository failures", async () => {
  const boom = new Error("db down");
  const err = await run(loadAccess({ findByUserId: async () => { throw boom; } }), { user: { id: "u1" } });
  assert.equal(err, boom);
});

test("requireRole passes allowed roles and rejects others with 403 FORBIDDEN_ROLE", async () => {
  const mw = requireRole("admin", "planner");
  assert.equal(await run(mw, { access: { role: "planner", sedeIds: [] } }), undefined);
  assert.equal(await run(mw, { access: { role: "admin", sedeIds: null } }), undefined);
  const err = await run(mw, { access: { role: "viewer", sedeIds: null } });
  assert.equal(err.statusCode, 403);
  assert.equal(err.code, "FORBIDDEN_ROLE");
});

test("requireRole without loaded access -> 403 FORBIDDEN_ROLE", async () => {
  const err = await run(requireRole("admin"), {});
  assert.equal(err.code, "FORBIDDEN_ROLE");
});

test("canAccessSede: admin sees everything; null sedeIds sees every sede but not null-sede rows", () => {
  assert.equal(canAccessSede({ role: "admin", sedeIds: ["x"] }, "other"), true);
  assert.equal(canAccessSede({ role: "admin", sedeIds: null }, null), true);
  assert.equal(canAccessSede({ role: "planner", sedeIds: null }, "other"), true);
  assert.equal(canAccessSede({ role: "planner", sedeIds: null }, null), false);
  assert.equal(canAccessSede({ role: "viewer", sedeIds: null }, null), false);
});

test("canAccessSede: scoped users need the sede in their list; null sede is admin-only", () => {
  const a = { role: "planner", sedeIds: ["s1", "s2"] };
  assert.equal(canAccessSede(a, "s2"), true);
  assert.equal(canAccessSede(a, "s3"), false);
  assert.equal(canAccessSede(a, null), false);
  assert.equal(canAccessSede(a, undefined), false);
  assert.equal(canAccessSede({ role: "viewer", sedeIds: [] }, "s1"), false);
  assert.equal(canAccessSede(null, "s1"), false);
});

test("requireSede passes in-scope sedes and rejects others with 403 FORBIDDEN_SEDE", async () => {
  const mw = requireSede((req) => req.params.sedeId);
  const access = { role: "planner", sedeIds: ["s1"] };
  assert.equal(await run(mw, { access, params: { sedeId: "s1" } }), undefined);
  const err = await run(mw, { access, params: { sedeId: "s9" } });
  assert.equal(err.statusCode, 403);
  assert.equal(err.code, "FORBIDDEN_SEDE");
});

test("requireSede supports async getters and missing access", async () => {
  const mw = requireSede(async () => "s1");
  assert.equal(await run(mw, { access: { role: "viewer", sedeIds: ["s1"] } }), undefined);
  const err = await run(mw, {});
  assert.equal(err.code, "FORBIDDEN_ROLE");
});
