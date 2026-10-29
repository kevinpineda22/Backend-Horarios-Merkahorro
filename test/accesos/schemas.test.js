import test from "node:test";
import assert from "node:assert/strict";

const { createAccessSchema, patchAccessSchema, listQuerySchema, lookupQuerySchema, idParamSchema } =
  await import("../../src/modules/accesos/accesos.schemas.js");

const UID = "11111111-1111-4111-8111-111111111111";
const ok = (schema, v) => schema.safeParse(v);

test("create: accepts each role with sedeIds null or a non-empty list", () => {
  for (const role of ["admin", "planner", "viewer"]) {
    assert.equal(ok(createAccessSchema, { userId: UID, role, sedeIds: null }).success, true, role);
  }
  const r = ok(createAccessSchema, { userId: UID, role: "viewer", sedeIds: ["s1", "s2"] });
  assert.deepEqual(r.data, { userId: UID, role: "viewer", sedeIds: ["s1", "s2"] });
});

test("create: rejects bad role, bad uuid, empty/blank sedeIds, missing fields", () => {
  const bad = [
    { userId: UID, role: "owner", sedeIds: null },
    { userId: "nope", role: "admin", sedeIds: null },
    { userId: UID, role: "admin", sedeIds: [] },
    { userId: UID, role: "admin", sedeIds: [""] },
    { userId: UID, role: "admin", sedeIds: [1] },
    { userId: UID, role: "admin" },
    { role: "admin", sedeIds: null },
  ];
  for (const b of bad) assert.equal(ok(createAccessSchema, b).success, false, JSON.stringify(b));
});

test("create: de-duplicates sedeIds and strips audit fields from the body", () => {
  const r = ok(createAccessSchema, { userId: UID, role: "viewer", sedeIds: ["s1", "s1"], createdBy: "evil", revokedAt: "x" });
  assert.deepEqual(r.data, { userId: UID, role: "viewer", sedeIds: ["s1"] });
});

test("patch: needs at least one field; validates role and sedeIds", () => {
  assert.equal(ok(patchAccessSchema, {}).success, false);
  assert.equal(ok(patchAccessSchema, { role: "planner" }).success, true);
  assert.equal(ok(patchAccessSchema, { sedeIds: null }).success, true);
  assert.equal(ok(patchAccessSchema, { role: "owner" }).success, false);
  assert.equal(ok(patchAccessSchema, { sedeIds: [] }).success, false);
});

test("list query: incluirRevocados defaults to false and parses 'true'", () => {
  assert.equal(ok(listQuerySchema, {}).data.incluirRevocados, false);
  assert.equal(ok(listQuerySchema, { incluirRevocados: "true" }).data.incluirRevocados, true);
  assert.equal(ok(listQuerySchema, { incluirRevocados: "maybe" }).success, false);
});

test("lookup query: q trimmed, 2 to 100 chars", () => {
  assert.equal(ok(lookupQuerySchema, { q: "  jua " }).data.q, "jua");
  assert.equal(ok(lookupQuerySchema, { q: "j" }).success, false);
  assert.equal(ok(lookupQuerySchema, {}).success, false);
  assert.equal(ok(lookupQuerySchema, { q: "x".repeat(101) }).success, false);
});

test("id param must be a uuid", () => {
  assert.equal(ok(idParamSchema, { id: UID }).success, true);
  assert.equal(ok(idParamSchema, { id: "1" }).success, false);
});
