import test from "node:test";
import assert from "node:assert/strict";

import { createSugeridoService } from "../../src/modules/sugerido/sugerido.service.js";
import { createHttpError } from "../../src/shared/http/HttpError.js";
import { addDays } from "../../src/modules/sugerido/domain/dates.js";
import { SETTINGS, SLOTS_PER_OPEN_DAY, USER, WEEK, makeDeps } from "./api.helpers.js";

// Default fixture: every slot requires 3 cashiers (see service.test.js); s1 has bodegas B1 + B2, s2 has B3.
const setup = (opts) => {
  const ctx = makeDeps(opts);
  return { ...ctx, service: createSugeridoService(ctx.deps) };
};
const slotOf = (view, fecha, franja) => view.days.find((d) => d.fecha === fecha).slots.find((s) => s.franja === franja);
const rejectsWith = (p, status, code) => assert.rejects(p, (e) => e.statusCode === status && e.code === code);
const registerWarnings = (view) => view.warnings.filter((w) => typeof w === "string" && w.startsWith("REGISTERS_CAP:"));
const SEDE_S1 = (registersOverride) => [{ sedeId: "s1", nombre: "Centro", bodegas: ["B1", "B2"], activo: true, registersOverride }];

test("computeRun asks for the bodegas of the sede up to the end of the target week and sums them", async () => {
  const { service, calls } = setup({ registers: { B1: 2, B2: 1, B3: 9 } });
  const view = await service.computeRun(USER, "s1", WEEK);
  assert.deepEqual(calls.registers, [{ bodegas: ["B1", "B2"], hasta: addDays(WEEK, 6) }]);
  assert.deepEqual(view.registers, { derived: 3, override: null, effective: 3 });
  assert.deepEqual(view.inputs.registers, { derived: 3, override: null, effective: 3 });
});

test("computeRun caps suggested (and final) to the registers, keeps required uncapped and warns", async () => {
  const { service, repo } = setup({ registers: { B1: 1, B2: 1 } }); // 2 registers, 3 required
  const view = await service.computeRun(USER, "s1", WEEK);
  const s = slotOf(view, WEEK, "08:00");
  assert.deepEqual([s.required, s.suggested, s.final, s.override, s.difference], [3, 2, 2, null, 0]);
  assert.equal(s.shortfall, 0);
  assert.equal(s.status, "ok");

  const saved = repo.calls.saveRun[0];
  assert.ok(saved.slots.every((x) => x.required === 3 && x.suggested === 2));
  assert.deepEqual(saved.inputs.registers, { derived: 2, override: null, effective: 2 });
  const warnings = registerWarnings({ warnings: saved.warnings });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(`${7 * SLOTS_PER_OPEN_DAY} franjas`));
  assert.equal(registerWarnings(view).length, 1, "the warning reaches the view");
});

test("the manual override replaces the derived count in the cap", async () => {
  const { service } = setup({ registers: { B1: 5, B2: 5 }, sedes: SEDE_S1(1) });
  const view = await service.computeRun(USER, "s1", WEEK);
  assert.deepEqual(view.registers, { derived: 10, override: 1, effective: 1 });
  assert.equal(slotOf(view, WEEK, "08:00").suggested, 1);
});

test("no cap and no warning when the registers cover the demand or are unknown", async () => {
  for (const registers of [{ B1: 2, B2: 1 }, {}, { B1: 0 }]) {
    const { service } = setup({ registers });
    const view = await service.computeRun(USER, "s1", WEEK);
    assert.equal(slotOf(view, WEEK, "08:00").suggested, 3, JSON.stringify(registers));
    assert.equal(registerWarnings(view).length, 0);
  }
  const { service } = setup({ registers: {} });
  assert.deepEqual((await service.computeRun(USER, "s1", WEEK)).registers, { derived: null, override: null, effective: null });
});

test("a failing register source fails the run and nothing is saved", async () => {
  const { service, state, repo } = setup();
  state.registers = createHttpError(503, "down", "SALES_DB_UNAVAILABLE");
  await rejectsWith(service.computeRun(USER, "s1", WEEK), 503, "SALES_DB_UNAVAILABLE");
  assert.equal(repo.runs.length, 0);
});

test("getWeek exposes the CURRENT registers, also for a week without a run", async () => {
  const { service } = setup({ registers: { B1: 6, B2: 4 } });
  const empty = await service.getWeek(USER, "s1", WEEK);
  assert.equal(empty.run, null);
  assert.deepEqual(empty.registers, { derived: 10, override: null, effective: 10 });

  await service.computeRun(USER, "s1", WEEK);
  const view = await service.getWeek(USER, "s1", WEEK);
  assert.deepEqual(view.registers, { derived: 10, override: null, effective: 10 });
  assert.deepEqual(view.inputs.registers, { derived: 10, override: null, effective: 10 });
});

test("getWeek reflects an override set after the run, while the run keeps its own snapshot", async () => {
  const { service } = setup({ registers: { B1: 6, B2: 4 } });
  await service.computeRun(USER, "s1", WEEK);
  await service.setRegistersOverride("s1", 2);
  const view = await service.getWeek(USER, "s1", WEEK);
  assert.deepEqual(view.registers, { derived: 10, override: 2, effective: 2 });
  assert.equal(view.inputs.registers.effective, 10);
  const slot = slotOf(view, WEEK, "08:00");
  assert.equal(slot.suggested, 3, "the stored suggestion is not rewritten");
  assert.deepEqual([slot.final, slot.cappedByRegisters], [2, true], "but the final shown is clamped to the current registers");
  assert.equal(slotOf(view, WEEK, "08:15").cappedByRegisters, true);
});

test("an override stored above the registers (before the feature, or registers lowered later) is clamped on read, not rewritten", async () => {
  const { service, repo } = setup({ registers: {} }); // unknown at first: nothing blocks the edit
  await service.computeRun(USER, "s1", WEEK);
  await service.saveOverrides(USER, "s1", WEEK, [{ fecha: WEEK, franja: "08:00", value: 9 }, { fecha: WEEK, franja: "06:00", value: 7 }]);
  await service.setRegistersOverride("s1", 4);

  const view = await service.getWeek(USER, "s1", WEEK);
  const s = slotOf(view, WEEK, "08:00");
  assert.deepEqual([s.override, s.final, s.difference, s.cappedByRegisters], [9, 4, 1, true]);
  const orphan = slotOf(view, WEEK, "06:00");
  assert.deepEqual([orphan.override, orphan.final, orphan.cappedByRegisters], [7, 4, true]);
  assert.equal("cappedByRegisters" in slotOf(view, WEEK, "08:15"), false, "untouched slots carry no flag");
  assert.equal(repo.overrides.get(`s1|${WEEK}|08:00`).headcount, 9, "the stored override is intact");

  await service.setRegistersOverride("s1", null); // lifting the cap brings the original value back
  assert.equal(slotOf(await service.getWeek(USER, "s1", WEEK), WEEK, "08:00").final, 9);
});

test("the week returned by saveOverrides and computeRun is reconciled with the registers too", async () => {
  const { service } = setup({ registers: { B1: 2, B2: 2 } });
  const run = await service.computeRun(USER, "s1", WEEK);
  assert.equal(slotOf(run, WEEK, "08:00").final, 3);
  const after = await service.saveOverrides(USER, "s1", WEEK, [{ fecha: WEEK, franja: "08:00", value: 4 }]);
  assert.deepEqual([slotOf(after, WEEK, "08:00").final, slotOf(after, WEEK, "08:00").cappedByRegisters], [4, undefined]);
});

const HIGH_MIN = { ...SETTINGS, minCashiers: 8 }; // every slot requires 8, the pool has 5 available

test("shortfall ignores cashiers who could never sit: min(required, registers) - available", async () => {
  const six = await setup({ settings: HIGH_MIN, registers: { B1: 3, B2: 3 } }).service.computeRun(USER, "s1", WEEK);
  const a = slotOf(six, WEEK, "08:00");
  assert.deepEqual([a.required, a.available, a.suggested, a.shortfall, a.status], [8, 5, 5, 1, "shortfall"]);

  const four = await setup({ settings: HIGH_MIN, registers: { B1: 2, B2: 2 } }).service.computeRun(USER, "s1", WEEK);
  const b = slotOf(four, WEEK, "08:00");
  assert.deepEqual([b.required, b.suggested, b.shortfall, b.status], [8, 4, 0, "ok"]);

  const unknown = await setup({ settings: HIGH_MIN }).service.computeRun(USER, "s1", WEEK);
  assert.deepEqual([slotOf(unknown, WEEK, "08:00").shortfall, slotOf(unknown, WEEK, "08:00").status], [3, "shortfall"]);
});

test("stored shortfall is recomputed on read with the current registers", async () => {
  const { service } = setup({ settings: HIGH_MIN, registers: { B1: 3, B2: 3 } });
  await service.computeRun(USER, "s1", WEEK);
  await service.setRegistersOverride("s1", 4);
  const s = slotOf(await service.getWeek(USER, "s1", WEEK), WEEK, "08:00");
  assert.deepEqual([s.required, s.shortfall, s.status], [8, 0, "ok"]);
});

test("derived registers degrade to unknown when the sales database fails on a read path", async () => {
  const { service, state } = setup();
  state.registers = createHttpError(503, "down", "SALES_DB_UNAVAILABLE");
  assert.deepEqual((await service.getWeek(USER, "s1", WEEK)).registers, { derived: null, override: null, effective: null });
  const sedes = await service.listSedes({ role: "admin", sedeIds: null });
  assert.deepEqual(sedes[0].registers, { derived: null, override: null, effective: null });
});

test("read paths share a cached derived count (TTL 10 minutes) and only query missing bodegas", async () => {
  const { service, calls, state } = setup({ registers: { B1: 6, B2: 4, B3: 3 } });
  await service.getWeek(USER, "s1", WEEK);
  await service.getWeek(USER, "s1", WEEK);
  await service.listSedes({ role: "admin", sedeIds: null });
  assert.equal(calls.registers.length, 2, "s1 once, then only the still-missing B3 for the list");
  assert.deepEqual(calls.registers[1].bodegas, ["B3"]);
  state.now = new Date(state.now.getTime() + 11 * 60 * 1000);
  await service.getWeek(USER, "s1", WEEK);
  assert.equal(calls.registers.length, 3);
});

test("listSedes: items carry registers from ONE grouped query; scoped callers only query their sedes", async () => {
  const { service, calls } = setup({ registers: { B1: 6, B2: 4, B3: 3 } });
  const all = await service.listSedes({ role: "admin", sedeIds: null });
  assert.deepEqual(calls.registers, [{ bodegas: ["B1", "B2", "B3"] }]);
  assert.deepEqual(all.map((s) => [s.sedeId, s.registers]), [
    ["s1", { derived: 10, override: null, effective: 10 }],
    ["s2", { derived: 3, override: null, effective: 3 }],
  ]);
  assert.ok(all.every((s) => !("registersOverride" in s)), "the raw column name is not leaked");

  const scoped = setup({ registers: { B3: 3 } });
  await scoped.service.listSedes({ role: "viewer", sedeIds: ["s2"] });
  assert.deepEqual(scoped.calls.registers, [{ bodegas: ["B3"] }]);
});

test("saveOverrides rejects a headcount above the registers: 422 REGISTERS_EXCEEDED with details, nothing written", async () => {
  const { service, repo } = setup({ registers: { B1: 2, B2: 2 } }); // 4 registers
  await service.computeRun(USER, "s1", WEEK);
  const items = [
    { fecha: WEEK, franja: "08:00", value: 4 },
    { fecha: WEEK, franja: "08:15", value: 5 },
    { fecha: WEEK, franja: "08:30", value: 7 },
    { fecha: WEEK, franja: "08:45", value: null },
  ];
  await assert.rejects(service.saveOverrides(USER, "s1", WEEK, items), (e) => {
    assert.equal(e.statusCode, 422);
    assert.equal(e.code, "REGISTERS_EXCEEDED");
    assert.equal(e.message, "La sede tiene 4 puestos de pago: no puedes programar más cajeras a la vez.");
    assert.equal(e.expose, true);
    assert.deepEqual(e.details, { registers: 4, exceeded: [{ fecha: WEEK, franja: "08:15", value: 5 }, { fecha: WEEK, franja: "08:30", value: 7 }] });
    return true;
  });
  assert.equal(repo.calls.applyOverrides.length, 0);
});

test("saveOverrides accepts exactly the registers, removals and orphan slots within the limit", async () => {
  const { service, repo } = setup({ registers: { B1: 2, B2: 2 } });
  await service.computeRun(USER, "s1", WEEK);
  const view = await service.saveOverrides(USER, "s1", WEEK, [
    { fecha: WEEK, franja: "08:00", value: 4 },
    { fecha: WEEK, franja: "06:00", value: 4 },
    { fecha: WEEK, franja: "08:15", value: null },
  ]);
  assert.equal(repo.calls.applyOverrides.length, 1);
  assert.equal(slotOf(view, WEEK, "08:00").final, 4);
});

test("saveOverrides uses the manual override when set, and does not check when registers are unknown", async () => {
  const withOverride = setup({ registers: { B1: 9 }, sedes: [{ sedeId: "s1", nombre: "C", bodegas: ["B1"], activo: true, registersOverride: 2 }] });
  await withOverride.service.computeRun(USER, "s1", WEEK);
  await rejectsWith(withOverride.service.saveOverrides(USER, "s1", WEEK, [{ fecha: WEEK, franja: "08:00", value: 3 }]), 422, "REGISTERS_EXCEEDED");

  const unknown = setup({ registers: {} });
  await unknown.service.computeRun(USER, "s1", WEEK);
  await unknown.service.saveOverrides(USER, "s1", WEEK, [{ fecha: WEEK, franja: "08:00", value: 40 }]);
  assert.equal(unknown.repo.calls.applyOverrides.length, 1);
});

test("saveOverrides is not blocked when the sales database is down (unknown registers)", async () => {
  const { service, state, repo } = setup({ registers: { B1: 1, B2: 1 } });
  await service.computeRun(USER, "s1", WEEK);
  state.registers = createHttpError(503, "down", "SALES_DB_UNAVAILABLE");
  await service.saveOverrides(USER, "s1", WEEK, [{ fecha: WEEK, franja: "08:00", value: 40 }]);
  assert.equal(repo.calls.applyOverrides.length, 1);
});

test("setRegistersOverride stores the value and answers { derived, override, effective }", async () => {
  const { service, repo } = setup({ registers: { B1: 6, B2: 4 } });
  assert.deepEqual(await service.setRegistersOverride("s1", 8), { derived: 10, override: 8, effective: 8 });
  assert.deepEqual(repo.calls.setRegistersOverride, [{ sedeId: "s1", override: 8 }]);
  assert.deepEqual(await service.setRegistersOverride("s1", null), { derived: 10, override: null, effective: 10 });
});

test("setRegistersOverride: unknown or inactive sede -> 404 and nothing is written", async () => {
  const { service, repo } = setup();
  await rejectsWith(service.setRegistersOverride("nope", 3), 404, "SEDE_NOT_MAPPED");
  await rejectsWith(service.setRegistersOverride("s3", 3), 404, "SEDE_NOT_MAPPED");
  assert.equal(repo.calls.setRegistersOverride.length, 0);
});

test("outage: a failed load is remembered for 60 s, so read paths do not hit the database on every call", async () => {
  const { service, calls, state } = setup();
  state.registers = createHttpError(503, "down", "SALES_DB_UNAVAILABLE");
  for (let i = 0; i < 3; i += 1) await service.getWeek(USER, "s1", WEEK);
  await service.listSedes({ role: "admin", sedeIds: null });
  assert.equal(calls.registers.length, 2, "s1 once, then only B3 once (its own failure is remembered too)");

  state.now = new Date(state.now.getTime() + 61 * 1000);
  await service.getWeek(USER, "s1", WEEK);
  assert.equal(calls.registers.length, 3, "retried after the backoff");
});

test("outage: recovery after the backoff restores the real count", async () => {
  const { service, state } = setup();
  state.registers = createHttpError(503, "down", "SALES_DB_UNAVAILABLE");
  assert.equal((await service.getWeek(USER, "s1", WEEK)).registers.derived, null);
  state.registers = { B1: 6, B2: 4 };
  state.now = new Date(state.now.getTime() + 61 * 1000);
  assert.equal((await service.getWeek(USER, "s1", WEEK)).registers.derived, 10);
});

test("outage: a stale cached count is kept (not replaced by unknown) while the source is down", async () => {
  const { service, state } = setup({ registers: { B1: 6, B2: 4 } });
  await service.getWeek(USER, "s1", WEEK);
  state.registers = createHttpError(503, "down", "SALES_DB_UNAVAILABLE");
  state.now = new Date(state.now.getTime() + 11 * 60 * 1000);
  assert.equal((await service.getWeek(USER, "s1", WEEK)).registers.derived, 10);
});

test("concurrent reads of the same bodegas share ONE in-flight query", async () => {
  const ctx = makeDeps({ registers: { B1: 6, B2: 4 } });
  let release;
  const gate = new Promise((r) => (release = r));
  let queries = 0;
  ctx.deps.salesRepo.loadRegisterCounts = async () => { queries += 1; await gate; return { B1: 6, B2: 4 }; };
  const service = createSugeridoService(ctx.deps);

  const reads = Promise.all([service.getWeek(USER, "s1", WEEK), service.getWeek(USER, "s1", WEEK), service.getWeek(USER, "s1", WEEK)]);
  await new Promise((r) => setTimeout(r, 20));
  release();
  const weeks = await reads;
  assert.equal(queries, 1);
  assert.ok(weeks.every((w) => w.registers.derived === 10));
});

// The pg pool has ONE connection: two sales queries at once make the second wait for the first and,
// past connectionTimeoutMillis, fail as "La base de ventas no está disponible" (seen in production).
test("computeRun never runs two sales queries at the same time", async () => {
  const ctx = makeDeps({ registers: { B1: 2, B2: 1 } });
  let inFlight = 0;
  let maxInFlight = 0;
  const track = (fn) => async (args) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await fn(args);
    } finally {
      inFlight -= 1;
    }
  };
  ctx.deps.salesRepo = {
    loadSlotHistory: track(ctx.deps.salesRepo.loadSlotHistory),
    loadRegisterCounts: track(ctx.deps.salesRepo.loadRegisterCounts),
  };
  await createSugeridoService(ctx.deps).computeRun(USER, "s1", WEEK);
  assert.equal(maxInFlight, 1);
});
