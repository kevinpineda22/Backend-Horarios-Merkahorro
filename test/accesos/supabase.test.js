import test from "node:test";
import assert from "node:assert/strict";

const { createAccesosRepo, createProfilesRepo } = await import("../../src/modules/accesos/accesos.supabase.js");

const UID = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";

function fake(result = { data: [], error: null }) {
  const log = [];
  const builder = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res, rej) => Promise.resolve(result).then(res, rej);
      return (...args) => (log.push([prop, ...args]), builder);
    },
  });
  return { log, client: { from: (t) => (log.push(["from", t]), builder), rpc: (n, a) => (log.push(["rpc", n, a]), Promise.resolve(result)) } };
}
const has = (log, ...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));
const rejects = (p, status, code) =>
  assert.rejects(p, (e) => e.statusCode === status && e.code === code && e.expose === true);

test("create calls the 003 RPC with actor and maps the row to a DTO", async () => {
  const row = { id: UID, user_id: ACTOR, role: "viewer", sede_ids: ["s1"], created_by: ACTOR, created_at: "t", updated_by: ACTOR, updated_at: "t", revoked_by: null, revoked_at: null };
  const { log, client } = fake({ data: row, error: null });
  const out = await createAccesosRepo(client).create({ userId: ACTOR, role: "viewer", sedeIds: ["s1"], actor: ACTOR });
  assert.ok(has(log, "rpc", "sugerido_access_create", { p_user_id: ACTOR, p_role: "viewer", p_sede_ids: ["s1"], p_actor: ACTOR }));
  assert.equal(out.id, UID);
  assert.equal(out.sede_ids[0], "s1");
});

test("update and revoke call their RPCs with the exact parameter names", async () => {
  const { log, client } = fake({ data: { id: UID }, error: null });
  const repo = createAccesosRepo(client);
  await repo.update({ id: UID, role: "planner", sedeIds: null, actor: ACTOR });
  await repo.revoke({ id: UID, actor: ACTOR });
  assert.ok(has(log, "rpc", "sugerido_access_update", { p_id: UID, p_role: "planner", p_sede_ids: null, p_actor: ACTOR }));
  assert.ok(has(log, "rpc", "sugerido_access_revoke", { p_id: UID, p_actor: ACTOR }));
});

test("RPC exceptions map to HTTP errors", async () => {
  const run = (message, code = "P0001") =>
    createAccesosRepo(fake({ data: null, error: { message, code } }).client).revoke({ id: UID, actor: ACTOR });
  await rejects(run("LAST_ADMIN"), 409, "LAST_ADMIN");
  await rejects(run("ACCESS_DUPLICATE", "23505"), 409, "DUPLICATE_ACCESS");
  await rejects(run("ACCESS_NOT_FOUND"), 404, "ACCESS_NOT_FOUND");
  // Unknown database errors are rethrown untouched (the handler answers a generic 500).
  await assert.rejects(run("boom", "XX000"), (e) => e.message === "boom" && !e.expose);
});

test("list selects audit columns, hides revoked rows by default", async () => {
  const { log, client } = fake();
  await createAccesosRepo(client).list({ incluirRevocados: false });
  assert.ok(has(log, "from", "sugerido_access"));
  assert.ok(has(log, "is", "revoked_at", null));
  const { log: log2, client: c2 } = fake();
  await createAccesosRepo(c2).list({ incluirRevocados: true });
  assert.ok(!log2.some((c) => c[0] === "is"));
});

test("findById only returns active rows; findExistingSedeIds queries sugerido_sedes", async () => {
  const a = fake({ data: null, error: null });
  assert.equal(await createAccesosRepo(a.client).findById(UID), null);
  assert.ok(has(a.log, "eq", "id", UID));
  assert.ok(has(a.log, "is", "revoked_at", null));
  const b = fake({ data: [{ sede_id: "s1" }], error: null });
  assert.deepEqual(await createAccesosRepo(b.client).findExistingSedeIds(["s1", "s9"]), ["s1"]);
  assert.ok(has(b.log, "from", "sugerido_sedes"));
  assert.ok(has(b.log, "in", "sede_id", ["s1", "s9"]));
});

test("profiles search selects only user_id, nombre, correo, with a limit and escaped term", async () => {
  const { log, client } = fake({ data: [{ user_id: UID, nombre: "Juan", correo: "j@x.co" }], error: null });
  const out = await createProfilesRepo(client).search("ju,an(%)*", 15);
  assert.ok(has(log, "from", "profiles"));
  assert.ok(has(log, "select", "user_id, nombre, correo"));
  assert.ok(has(log, "limit", 15));
  const or = log.find((c) => c[0] === "or")[1];
  assert.ok(or.includes("nombre.ilike.%juan%") && or.includes("correo.ilike.%juan%"), or);
  assert.deepEqual(out, [{ user_id: UID, nombre: "Juan", correo: "j@x.co" }]);
});

test("profiles search: ilike wildcards are stripped, so '%%' or '__' never match everyone", async () => {
  for (const term of ["%%", "__", "_%_"]) {
    const { log, client } = fake({ data: [{ user_id: UID }], error: null });
    const out = await createProfilesRepo(client).search(term, 20);
    assert.deepEqual(out, [], term);
    assert.equal(log.length, 0, `no query for ${term}`);
  }
  const { log, client } = fake({ data: [], error: null });
  await createProfilesRepo(client).search("ju_an", 20);
  const or = log.find((c) => c[0] === "or")[1];
  assert.ok(or.includes("nombre.ilike.%juan%"), or);
});

test("profiles findById selects only identifying fields", async () => {
  const { log, client } = fake({ data: { user_id: UID, nombre: "Juan", correo: "j@x.co" }, error: null });
  const out = await createProfilesRepo(client).findById(UID);
  assert.ok(has(log, "select", "user_id, nombre, correo"));
  assert.ok(has(log, "eq", "user_id", UID));
  assert.equal(out.user_id, UID);
});
