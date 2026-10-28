import test from "node:test";
import assert from "node:assert/strict";

const { createNovedadesRepo } = await import("../../src/modules/novedades/novedades.supabase.js");
const { createAccessRepo } = await import("../../src/shared/access/access.supabase.js");

// Recording fake of the supabase-js query builder: every chained call is logged and the
// builder is thenable, resolving to `result`.
function fakeClient(result = { data: [], error: null }) {
  const log = [];
  const builder = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
        return (...args) => {
          log.push([prop, ...args]);
          return builder;
        };
      },
    },
  );
  return { log, client: { from: (t) => (log.push(["from", t]), builder) } };
}
const has = (log, ...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));

test("repo.list builds overlap + scope filters on the novedades table", async () => {
  const { log, client } = fakeClient();
  await createNovedadesRepo(client).list({
    sede: "s1", sedeIds: ["s1", "s3"], sedeNotNull: true, cedula: "123456", tipo: "Estudio",
    desde: "2026-11-18", hasta: "2026-11-25", incluirAnuladas: false, limit: 501,
  });
  assert.ok(has(log, "from", "novedades"));
  assert.ok(has(log, "eq", "anulada", false));
  assert.ok(has(log, "eq", "sede_id", "s1"));
  assert.ok(has(log, "in", "sede_id", ["s1", "s3"]));
  assert.ok(has(log, "not", "sede_id", "is", null));
  assert.ok(has(log, "eq", "cedula", "123456"));
  assert.ok(has(log, "eq", "tipo", "Estudio"));
  assert.ok(has(log, "gte", "fecha_fin", "2026-11-18")); // row ends on/after range start
  assert.ok(has(log, "lte", "fecha_inicio", "2026-11-25")); // row starts on/before range end
  assert.ok(has(log, "order", "fecha_inicio", { ascending: false }));
  assert.ok(has(log, "limit", 501));
});

test("repo.list adds no optional filters when absent and includes cancelled on request", async () => {
  const { log, client } = fakeClient();
  await createNovedadesRepo(client).list({ incluirAnuladas: true, limit: 10, sedeIds: null, sedeNotNull: false });
  assert.deepEqual(log.map((c) => c[0]).filter((m) => ["eq", "in", "not", "gte", "lte"].includes(m)), []);
});

test("repo.findOverlapping queries active rows of the cedula, excluding the given id", async () => {
  const { log, client } = fakeClient({ data: [{ id: "x" }], error: null });
  const rows = await createNovedadesRepo(client).findOverlapping({ cedula: "123456", desde: "2026-11-01", hasta: "2026-11-05", excludeId: "me" });
  assert.deepEqual(rows, [{ id: "x" }]);
  assert.ok(has(log, "eq", "cedula", "123456"));
  assert.ok(has(log, "eq", "anulada", false));
  assert.ok(has(log, "lte", "fecha_inicio", "2026-11-05"));
  assert.ok(has(log, "gte", "fecha_fin", "2026-11-01"));
  assert.ok(has(log, "neq", "id", "me"));
  const none = fakeClient();
  await createNovedadesRepo(none.client).findOverlapping({ cedula: "1", desde: "a", hasta: "b" });
  assert.equal(none.log.some((c) => c[0] === "neq"), false);
});

test("repo.update with onlyActive guards on anulada=false and returns null when nothing matched", async () => {
  const { log, client } = fakeClient({ data: null, error: null });
  const out = await createNovedadesRepo(client).update("id1", { tipo: "Estudio" }, { onlyActive: true });
  assert.equal(out, null);
  assert.ok(has(log, "update", { tipo: "Estudio" }));
  assert.ok(has(log, "eq", "id", "id1"));
  assert.ok(has(log, "eq", "anulada", false));
  const loose = fakeClient({ data: { id: "id1" }, error: null });
  await createNovedadesRepo(loose.client).update("id1", {}, {});
  assert.equal(has(loose.log, "eq", "anulada", false), false);
});

test("repo: FK violation (23503) maps to 404 SEDE_NOT_FOUND; other errors propagate", async () => {
  const fk = fakeClient({ data: null, error: { code: "23503", message: "fk" } });
  const repo = createNovedadesRepo(fk.client);
  await assert.rejects(repo.insert({ sede_id: "zz" }), (e) => e.statusCode === 404 && e.code === "SEDE_NOT_FOUND");
  await assert.rejects(repo.update("i", { sede_id: "zz" }, {}), (e) => e.statusCode === 404 && e.code === "SEDE_NOT_FOUND");
  const boom = fakeClient({ data: null, error: Object.assign(new Error("db down"), { code: "XX000" }) });
  await assert.rejects(createNovedadesRepo(boom.client).list({ limit: 1 }), (e) => e.statusCode === undefined && /db down/.test(e.message));
  await assert.rejects(createNovedadesRepo(boom.client).findById("i"), /db down/);
});

test("repo.insert returns the created row", async () => {
  const { log, client } = fakeClient({ data: { id: "n1" }, error: null });
  assert.deepEqual(await createNovedadesRepo(client).insert({ cedula: "1" }), { id: "n1" });
  assert.ok(has(log, "insert", { cedula: "1" }));
});

test("access repo: returns the row or null, throws on error", async () => {
  const hit = fakeClient({ data: { role: "planner", sede_ids: ["s1"] }, error: null });
  assert.deepEqual(await createAccessRepo(hit.client).findByUserId("u1"), { role: "planner", sede_ids: ["s1"] });
  assert.ok(has(hit.log, "from", "sugerido_access"));
  assert.ok(has(hit.log, "eq", "user_id", "u1"));
  assert.equal(await createAccessRepo(fakeClient({ data: null, error: null }).client).findByUserId("u1"), null);
  await assert.rejects(createAccessRepo(fakeClient({ data: null, error: new Error("down") }).client).findByUserId("u"), /down/);
});
