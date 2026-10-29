import test from "node:test";
import assert from "node:assert/strict";
import { createSuggestionsRepo } from "../../src/modules/sugerido/repositories/suggestions.supabase.js";
import { fakeSupabase, has } from "./helpers.js";

const ok = (data) => ({ data, error: null });
const SEDE = { sede_id: "villahermosa", nombre: "Villahermosa", bodegas: ["00201", "PV002"], activo: true };
const repoWith = (tables = {}, rpcs = {}) => createSuggestionsRepo(fakeSupabase({ tables, rpcs }).client);

test("listSedes maps rows to camelCase ordered by id", async () => {
  const { client, log } = fakeSupabase({ tables: { sugerido_sedes: ok([SEDE]) } });
  assert.deepEqual(await createSuggestionsRepo(client).listSedes(), [
    { sedeId: "villahermosa", nombre: "Villahermosa", bodegas: ["00201", "PV002"], activo: true },
  ]);
  assert.ok(has(log, "from", "sugerido_sedes"));
  assert.ok(has(log, "order", "sede_id", { ascending: true }));
  assert.deepEqual(await repoWith({ sugerido_sedes: ok(null) }).listSedes(), []);
});

test("getSede returns the mapping; unknown or bodega-less sede -> 404 SEDE_NOT_MAPPED", async () => {
  const { client, log } = fakeSupabase({ tables: { sugerido_sedes: ok(SEDE) } });
  assert.equal((await createSuggestionsRepo(client).getSede("villahermosa")).bodegas.length, 2);
  assert.ok(has(log, "eq", "sede_id", "villahermosa"));
  for (const data of [null, { ...SEDE, bodegas: [] }, { ...SEDE, bodegas: null }]) {
    await assert.rejects(
      repoWith({ sugerido_sedes: ok(data) }).getSede("x"),
      (e) => e.statusCode === 404 && e.code === "SEDE_NOT_MAPPED" && e.expose,
    );
  }
  await assert.rejects(repoWith({ sugerido_sedes: { data: null, error: new Error("down") } }).getSede("x"), /down/);
});

const RUN_INPUT = {
  sedeId: "villahermosa",
  weekStart: "2026-11-02",
  method: "blend",
  settings: { utilization: 0.85 },
  inputs: { a: 1 },
  flags: { noHistory: false },
  warnings: [],
  dataAsOf: "2026-10-28",
  createdBy: "u1",
  slots: [
    { fecha: "2026-11-02", franja: "08:00", forecastDocs: 12.5, forecastVenta: 100, required: 3, available: 2, suggested: 2, shortfall: 1, status: "short" },
  ],
};

test("saveRun calls rpc sugerido_save_run with snake_case run + settings snapshot + slots", async () => {
  const { client, log } = fakeSupabase({ rpcs: { sugerido_save_run: ok({ id: "r1", version: 3 }) } });
  const out = await createSuggestionsRepo(client).saveRun(RUN_INPUT);
  assert.deepEqual(out, { id: "r1", version: 3 });
  const [, fn, args] = log.find((c) => c[0] === "rpc");
  assert.equal(fn, "sugerido_save_run");
  assert.deepEqual(args.p_run, {
    sede_id: "villahermosa",
    week_start: "2026-11-02",
    method: "blend",
    settings: { utilization: 0.85 },
    inputs: { a: 1 },
    flags: { noHistory: false },
    warnings: [],
    data_as_of: "2026-10-28",
    created_by: "u1",
  });
  assert.deepEqual(args.p_slots, [
    { fecha: "2026-11-02", franja: "08:00", forecast_docs: 12.5, forecast_venta: 100, required: 3, available: 2, suggested: 2, shortfall: 1, status: "short" },
  ]);
});

test("saveRun preserves nulls and rejects missing snapshot or empty slots before the rpc", async () => {
  const { client, log } = fakeSupabase({ rpcs: { sugerido_save_run: ok({ id: "r1", version: 1 }) } });
  const repo = createSuggestionsRepo(client);
  await repo.saveRun({
    ...RUN_INPUT,
    dataAsOf: undefined,
    slots: [{ ...RUN_INPUT.slots[0], required: null, suggested: null, shortfall: null, status: "unknown" }],
  });
  const args = log.find((c) => c[0] === "rpc")[2];
  assert.equal(args.p_run.data_as_of, null);
  assert.equal(args.p_slots[0].required, null);
  assert.equal(args.p_slots[0].shortfall, null);
  const before = log.length;
  await assert.rejects(repo.saveRun({ ...RUN_INPUT, settings: undefined }), /settings/);
  await assert.rejects(repo.saveRun({ ...RUN_INPUT, slots: [] }), /slots/);
  assert.equal(log.length, before);
});

test("saveRun surfaces rpc errors, FK violation as 404 SEDE_NOT_MAPPED, malformed result as error", async () => {
  const failWith = (error) => repoWith({}, { sugerido_save_run: { data: null, error } });
  await assert.rejects(failWith(new Error("rpc down")).saveRun(RUN_INPUT), /rpc down/);
  await assert.rejects(failWith({ code: "23503", message: "fk" }).saveRun(RUN_INPUT), (e) => e.statusCode === 404 && e.code === "SEDE_NOT_MAPPED");
  await assert.rejects(repoWith({}, { sugerido_save_run: ok({}) }).saveRun(RUN_INPUT), /unexpected/i);
});

const RUN_ROW = {
  id: "r1",
  sede_id: "villahermosa",
  week_start: "2026-11-02",
  version: 2,
  method: "blend",
  settings: { utilization: 0.85 },
  inputs: {},
  flags: { noProductivity: false },
  warnings: ["w"],
  data_as_of: "2026-10-28",
  created_by: "u1",
  created_at: "2026-10-29T00:00:00Z",
};
const SLOT_ROWS = [
  { fecha: "2026-11-02", franja: "08:00:00", forecast_docs: "12.5", forecast_venta: "100", required: 3, available: 2, suggested: 2, shortfall: 1, status: "short" },
  { fecha: "2026-11-02", franja: "08:15:00", forecast_docs: "0", forecast_venta: "0", required: null, available: 0, suggested: null, shortfall: null, status: "unknown" },
];

test("getLatestRun returns the highest version with parsed slots; none -> null", async () => {
  const { client, log } = fakeSupabase({ tables: { sugerido_runs: ok(RUN_ROW), sugerido_slots: ok(SLOT_ROWS) } });
  const run = await createSuggestionsRepo(client).getLatestRun("villahermosa", "2026-11-02");
  assert.ok(has(log, "eq", "sede_id", "villahermosa"));
  assert.ok(has(log, "eq", "week_start", "2026-11-02"));
  assert.ok(has(log, "order", "version", { ascending: false }));
  assert.ok(has(log, "limit", 1));
  assert.ok(has(log, "eq", "run_id", "r1"));
  assert.ok(has(log, "order", "franja", { ascending: true }));
  assert.equal(run.version, 2);
  assert.equal(run.dataAsOf, "2026-10-28");
  assert.equal(run.createdBy, "u1");
  assert.deepEqual(run.settings, { utilization: 0.85 });
  assert.deepEqual(run.slots[0], {
    fecha: "2026-11-02", franja: "08:00", forecastDocs: 12.5, forecastVenta: 100, required: 3, available: 2, suggested: 2, shortfall: 1, status: "short",
  });
  assert.equal(run.slots[1].required, null);
  assert.equal(run.slots[1].shortfall, null);
  const none = fakeSupabase({ tables: { sugerido_runs: ok(null) } });
  assert.equal(await createSuggestionsRepo(none.client).getLatestRun("x", "2026-11-02"), null);
  assert.equal(none.log.some((c) => c[0] === "from" && c[1] === "sugerido_slots"), false);
});

test("getLatestRun rejects non-numeric slot values and propagates errors", async () => {
  const bad = repoWith({ sugerido_runs: ok(RUN_ROW), sugerido_slots: ok([{ ...SLOT_ROWS[0], forecast_docs: "x" }]) });
  await assert.rejects(bad.getLatestRun("a", "2026-11-02"), /forecast_docs/);
  await assert.rejects(repoWith({ sugerido_runs: { data: null, error: new Error("e1") } }).getLatestRun("a", "2026-11-02"), /e1/);
  const e2 = repoWith({ sugerido_runs: ok(RUN_ROW), sugerido_slots: { data: null, error: new Error("e2") } });
  await assert.rejects(e2.getLatestRun("a", "2026-11-02"), /e2/);
});

test("getOverrides filters sede + inclusive date range and maps rows", async () => {
  const rows = [{ fecha: "2026-11-02", franja: "08:00:00", headcount: 5, suggested_at_edit: 3, reason: "peak", updated_by: "u1", updated_at: "t" }];
  const { client, log } = fakeSupabase({ tables: { sugerido_overrides: ok(rows) } });
  const out = await createSuggestionsRepo(client).getOverrides("villahermosa", { desde: "2026-11-02", hasta: "2026-11-08" });
  assert.ok(has(log, "eq", "sede_id", "villahermosa"));
  assert.ok(has(log, "gte", "fecha", "2026-11-02"));
  assert.ok(has(log, "lte", "fecha", "2026-11-08"));
  assert.deepEqual(out, [{ fecha: "2026-11-02", franja: "08:00", headcount: 5, suggestedAtEdit: 3, reason: "peak", updatedBy: "u1", updatedAt: "t" }]);
  const range = { desde: "2026-11-02", hasta: "2026-11-08" };
  assert.deepEqual(await repoWith({ sugerido_overrides: ok(null) }).getOverrides("x", range), []);
  await assert.rejects(repoWith({ sugerido_overrides: { data: null, error: new Error("e3") } }).getOverrides("x", range), /e3/);
});

test("applyOverrides maps items to the rpc (null value = remove) and returns counts", async () => {
  const { client, log } = fakeSupabase({ rpcs: { sugerido_apply_overrides: ok({ upserted: 1, deleted: 1 }) } });
  const out = await createSuggestionsRepo(client).applyOverrides({
    sedeId: "villahermosa",
    userId: "u1",
    items: [
      { fecha: "2026-11-02", franja: "08:00", value: 5, suggestedAtEdit: 3, reason: "peak" },
      { fecha: "2026-11-02", franja: "08:15", value: null },
      { fecha: "2026-11-02", franja: "08:30", value: 0 },
    ],
  });
  assert.deepEqual(out, { upserted: 1, deleted: 1 });
  const [, fn, args] = log.find((c) => c[0] === "rpc");
  assert.equal(fn, "sugerido_apply_overrides");
  assert.equal(args.p_sede, "villahermosa");
  assert.equal(args.p_user, "u1");
  assert.deepEqual(args.p_items, [
    { fecha: "2026-11-02", franja: "08:00", headcount: 5, suggested_at_edit: 3, reason: "peak" },
    { fecha: "2026-11-02", franja: "08:15", headcount: null, suggested_at_edit: null, reason: null },
    { fecha: "2026-11-02", franja: "08:30", headcount: 0, suggested_at_edit: null, reason: null },
  ]);
});

test("applyOverrides: empty items skip the rpc; errors propagate; FK -> SEDE_NOT_MAPPED; bad result errors", async () => {
  const { client, log } = fakeSupabase();
  assert.deepEqual(await createSuggestionsRepo(client).applyOverrides({ sedeId: "s", userId: "u", items: [] }), { upserted: 0, deleted: 0 });
  assert.equal(log.length, 0);
  const failWith = (error) => repoWith({}, { sugerido_apply_overrides: { data: null, error } });
  const input = { sedeId: "s", userId: "u", items: [{ fecha: "2026-11-02", franja: "08:00", value: 1 }] };
  await assert.rejects(failWith(new Error("e4")).applyOverrides(input), /e4/);
  await assert.rejects(failWith({ code: "23503" }).applyOverrides(input), (e) => e.code === "SEDE_NOT_MAPPED");
  await assert.rejects(repoWith({}, { sugerido_apply_overrides: ok({ upserted: "x" }) }).applyOverrides(input), /unexpected/i);
});
