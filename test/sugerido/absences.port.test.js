import test from "node:test";
import assert from "node:assert/strict";

import { createAbsencesPort } from "../../src/modules/sugerido/repositories/absences.port.js";
import { createNovedadesRepo } from "../../src/modules/novedades/novedades.supabase.js";
import { NOVEDAD_TYPES } from "../../src/modules/novedades/domain/novedadTypes.js";
import { fakeSupabase, has } from "./helpers.js";

const nov = (id, cedula, tipo, ini, fin, extra = {}) => ({
  id, cedula, tipo, fecha_inicio: ini, fecha_fin: fin, anulada: false, ...extra,
});

test("repo.listActiveOverlapping filters by range, not cancelled and blocking types only", async () => {
  const { client, log } = fakeSupabase({ tables: { novedades: { data: [], error: null } } });
  await createNovedadesRepo(client).listActiveOverlapping({
    desde: "2026-11-02", hasta: "2026-11-08", tipos: ["Vacaciones", "Estudio"],
  });
  assert.ok(has(log, "from", "novedades"));
  assert.ok(has(log, "eq", "anulada", false));
  assert.ok(has(log, "lte", "fecha_inicio", "2026-11-08"));
  assert.ok(has(log, "gte", "fecha_fin", "2026-11-02"));
  assert.ok(has(log, "in", "tipo", ["Vacaciones", "Estudio"]));
  assert.ok(!log.some((c) => c.includes("sede_id")), "no sede/user scoping, null-sede rows included");
  const select = log.find((c) => c[0] === "select");
  assert.equal(select[1], "id, cedula, tipo, fecha_inicio, fecha_fin, anulada", "only the columns availability needs");
  assert.ok(has(log, "range", 0, 999), "default page size is 1000");
});

test("repo.listActiveOverlapping with no blocking types returns [] without querying", async () => {
  const { client, log } = fakeSupabase();
  const rows = await createNovedadesRepo(client).listActiveOverlapping({
    desde: "2026-11-02", hasta: "2026-11-08", tipos: [],
  });
  assert.deepEqual(rows, []);
  assert.equal(log.length, 0);
});

test("repo.listActiveOverlapping pages through all rows and surfaces query errors", async () => {
  const page1 = [nov(1, "11111", "Permisos", "2026-11-02", "2026-11-02"), nov(2, "22222", "Permisos", "2026-11-03", "2026-11-03")];
  const page2 = [nov(3, "33333", "Permisos", "2026-11-04", "2026-11-04")];
  const { client, log } = fakeSupabase({
    tables: { novedades: [{ data: page1, error: null }, { data: page2, error: null }, { data: [], error: null }] },
  });
  const rows = await createNovedadesRepo(client).listActiveOverlapping({
    desde: "2026-11-02", hasta: "2026-11-08", tipos: ["Permisos"], pageSize: 2,
  });
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
  assert.ok(has(log, "range", 0, 1));
  assert.ok(has(log, "range", 2, 3));

  const failing = fakeSupabase({ tables: { novedades: { data: null, error: { message: "db down" } } } });
  await assert.rejects(
    createNovedadesRepo(failing.client).listActiveOverlapping({
      desde: "2026-11-02", hasta: "2026-11-08", tipos: ["Permisos"],
    }),
    (e) => e.message === "db down",
  );
});

const PARGS = { desde: "2026-11-02", hasta: "2026-11-08", tipos: ["Permisos"] };
const rowsOf = (from, n) => Array.from({ length: n }, (_, i) => nov(from + i, "1", "Permisos", "2026-11-02", "2026-11-02"));
const ok = (data) => ({ data, error: null });

test("repo.listActiveOverlapping reads until an EMPTY page (full page, short page, empty)", async () => {
  const { client, log } = fakeSupabase({
    tables: { novedades: [ok(rowsOf(1, 1000)), ok(rowsOf(1001, 3)), ok([])] },
  });
  const rows = await createNovedadesRepo(client).listActiveOverlapping(PARGS);
  assert.equal(rows.length, 1003);
  assert.ok(has(log, "range", 0, 999));
  assert.ok(has(log, "range", 1000, 1999));
  assert.ok(has(log, "range", 2000, 2999));
});

test("repo.listActiveOverlapping survives a server cap below the page size", async () => {
  const { client } = fakeSupabase({
    tables: { novedades: [ok(rowsOf(1, 500)), ok(rowsOf(501, 500)), ok(rowsOf(1001, 7)), ok([])] },
  });
  const rows = await createNovedadesRepo(client).listActiveOverlapping(PARGS);
  assert.equal(rows.length, 1007);
});

test("repo.listActiveOverlapping uses a stable id order", async () => {
  const { client, log } = fakeSupabase({ tables: { novedades: [ok([])] } });
  await createNovedadesRepo(client).listActiveOverlapping(PARGS);
  assert.ok(has(log, "order", "id", { ascending: true }));
});

test("repo.listActiveOverlapping throws when the max-pages guard is exceeded (never truncates)", async () => {
  const pages = Array.from({ length: 6 }, (_, i) => ok(rowsOf(i * 2 + 1, 2)));
  const { client } = fakeSupabase({ tables: { novedades: pages } });
  await assert.rejects(
    createNovedadesRepo(client).listActiveOverlapping({ ...PARGS, pageSize: 2, maxPages: 5 }),
    /max pages|too many/i,
  );
  const exact = fakeSupabase({ tables: { novedades: [ok(rowsOf(1, 2)), ok(rowsOf(3, 2)), ok([])] } });
  const okRows = await createNovedadesRepo(exact.client).listActiveOverlapping({ ...PARGS, pageSize: 2, maxPages: 3 });
  assert.equal(okRows.length, 4);
});

function portWith(rows) {
  const calls = [];
  const repo = {
    async listActiveOverlapping(args) {
      calls.push(args);
      return rows;
    },
  };
  return { port: createAbsencesPort(repo), calls };
}

test("port asks the repo for the Monday-Sunday range with the blocking types", async () => {
  const { port, calls } = portWith([]);
  await port.getAbsences({ weekStart: "2026-11-02", blockingTypes: ["Vacaciones", "Estudio"] });
  assert.deepEqual(calls, [{ desde: "2026-11-02", hasta: "2026-11-08", tipos: ["Vacaciones", "Estudio"] }]);
});

test("port defaults to all six types and drops unknown types from the request", async () => {
  const a = portWith([]);
  await a.port.getAbsences({ weekStart: "2026-11-02" });
  assert.deepEqual(a.calls[0].tipos, [...NOVEDAD_TYPES]);
  const b = portWith([]);
  await b.port.getAbsences({ weekStart: "2026-11-02", blockingTypes: ["Estudio", "Sabatico"] });
  assert.deepEqual(b.calls[0].tipos, ["Estudio"]);
});

test("port output feeds the domain: normalized cedulas, null-sede rows kept, cancelled skipped", async () => {
  const { port } = portWith([
    nov(1, "0012345", "Vacaciones", "2026-10-30", "2026-11-03", { sede_id: null }),
    nov(2, "67890", "Estudio", "2026-11-04", "2026-11-04", { sede_id: "s9" }),
    nov(3, "11111", "Permisos", "2026-11-04", "2026-11-04", { anulada: true }),
    nov(4, "22222", "Permisos", "bad", "2026-11-04"),
  ]);
  const { absences, warnings } = await port.getAbsences({ weekStart: "2026-11-02" });
  assert.deepEqual(absences, [
    { id: 1, cedula: "12345", tipo: "Vacaciones", start: "2026-10-30", end: "2026-11-03" },
    { id: 2, cedula: "67890", tipo: "Estudio", start: "2026-11-04", end: "2026-11-04" },
  ]);
  assert.equal(warnings.length, 1);
});

test("port errors propagate and a non-array repo result is not treated as no absences", async () => {
  const boom = new Error("db down");
  const failing = createAbsencesPort({
    async listActiveOverlapping() {
      throw boom;
    },
  });
  await assert.rejects(failing.getAbsences({ weekStart: "2026-11-02" }), (e) => e === boom);
  const bad = createAbsencesPort({
    async listActiveOverlapping() {
      return null;
    },
  });
  await assert.rejects(bad.getAbsences({ weekStart: "2026-11-02" }));
});

test("port requires a repository", () => {
  assert.throws(() => createAbsencesPort(undefined));
});

test("repo.listActiveOverlapping fails loudly on invalid tipos or a malformed page", async () => {
  const { client } = fakeSupabase();
  await assert.rejects(createNovedadesRepo(client).listActiveOverlapping({ desde: "2026-11-02", hasta: "2026-11-08" }));
  for (const data of [null, {}, "x"]) {
    const bad = fakeSupabase({ tables: { novedades: { data, error: null } } });
    await assert.rejects(
      createNovedadesRepo(bad.client).listActiveOverlapping({ desde: "2026-11-02", hasta: "2026-11-08", tipos: ["Permisos"] }),
    );
  }
});

test("port drops rows of types outside the requested blocking types", async () => {
  const { port } = portWith([
    nov(1, "11111", "Vacaciones", "2026-11-02", "2026-11-03"),
    nov(2, "22222", "Estudio", "2026-11-02", "2026-11-03"),
  ]);
  const { absences } = await port.getAbsences({ weekStart: "2026-11-02", blockingTypes: ["Estudio"] });
  assert.deepEqual(absences.map((a) => a.id), [2]);
});
