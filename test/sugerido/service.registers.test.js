import test from "node:test";
import assert from "node:assert/strict";

import { createSugeridoService } from "../../src/modules/sugerido/sugerido.service.js";
import { createHttpError } from "../../src/shared/http/HttpError.js";
import { addDays } from "../../src/modules/sugerido/domain/dates.js";
import { SLOTS_PER_OPEN_DAY, USER, WEEK, makeDeps } from "./api.helpers.js";

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
  assert.equal(slotOf(view, WEEK, "08:00").suggested, 3, "the stored run is not re-capped on read");
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
