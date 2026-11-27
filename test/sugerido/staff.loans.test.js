import test from "node:test";
import assert from "node:assert/strict";

import { createStaffPort } from "../../src/modules/sugerido/repositories/staff.port.js";

const W = "2031-01-06";

const row = (cedula, cargo, sedeId, extra = {}) => ({ cedula, nombre: "N", cargo, sedeId, activo: true, ...extra });
const DIRECTORY = [
  row("111111", "Cajera", "s1"),
  row("222222", "Cajero", "s1"),
  row("333333", "Cajera", "s2"),
  row("444444", "Auxiliar de Fruver", "s2", { incluidoEnCaja: true }), // marked "Programar en caja"
  row("555555", "Auxiliar de Fruver", "s2"), // not a cashier
  row("666666", "Cajera", "s2", { excluidoDeCaja: true }), // Solo surtidor
  row("777777", "Cajera", "s2", { precontractual: true }), // no contract, no include mark
  row("888888", "Cajera", "s2", { activo: false }),
];

function setup({ loans = [], rows = DIRECTORY, withRepo = true } = {}) {
  const listCalls = [];
  const loanCalls = [];
  const empleados = {
    async list(_access, filters) {
      listCalls.push(filters);
      return { data: filters.sede ? rows.filter((r) => r.sedeId === filters.sede) : rows, total: rows.length };
    },
  };
  const sedeRepo = { async getSede(id) { return { sedeId: id }; } };
  const loansRepo = { async listActiveByWeek(week) { loanCalls.push(week); return loans.filter((l) => l.weekStart === week); } };
  return { port: createStaffPort(empleados, sedeRepo, withRepo ? loansRepo : null), listCalls, loanCalls };
}
const loan = (cedula, homeSedeId, hostSedeId, weekStart = W) => ({ id: `l-${cedula}`, cedula, homeSedeId, hostSedeId, weekStart });
const cedulas = (pool) => pool.map((p) => p.cedula).sort();

test("without a week (or without a loans repo) the pool is the old one and loans are never read", async () => {
  const loans = [loan("111111", "s1", "s2")];
  const noWeek = setup({ loans });
  assert.deepEqual(cedulas(await noWeek.port.getCashierPool("s1")), ["111111", "222222"]);
  assert.equal(noWeek.loanCalls.length, 0);
  const noRepo = setup({ loans, withRepo: false });
  assert.deepEqual(cedulas(await noRepo.port.getCashierPool("s1", W)), ["111111", "222222"]);
});

test("a week with no loans keeps the pool and does a single directory read", async () => {
  const { port, listCalls, loanCalls } = setup();
  assert.deepEqual(cedulas(await port.getCashierPool("s1", W)), ["111111", "222222"]);
  assert.deepEqual(loanCalls, [W]);
  assert.equal(listCalls.length, 1);
});

test("lent OUT: the person leaves the pool of her home sede for that week only", async () => {
  const { port } = setup({ loans: [loan("111111", "s1", "s2")] });
  assert.deepEqual(cedulas(await port.getCashierPool("s1", W)), ["222222"]);
  assert.deepEqual(cedulas(await port.getCashierPool("s1", "2031-01-13")), ["111111", "222222"], "another week has no loan");
});

test("lent IN: a cashier of another sede joins the pool of the host sede, and is not in her home pool", async () => {
  const { port } = setup({ loans: [loan("111111", "s1", "s2")] });
  assert.deepEqual(cedulas(await port.getCashierPool("s2", W)), ["111111", "333333", "444444"]);
  assert.deepEqual(cedulas(await port.getCashierPool("s1", W)), ["222222"]);
});

test("lent IN applies the same eligibility: not-a-cashier, Solo surtidor, pre-contractual and inactive people do not join", async () => {
  const loans = ["555555", "666666", "777777", "888888"].map((c) => loan(c, "s2", "s1"));
  const { port } = setup({ loans });
  assert.deepEqual(cedulas(await port.getCashierPool("s1", W)), ["111111", "222222"]);
});

test("lent IN: somebody with another cargo joins when she carries the 'Programar en caja' mark", async () => {
  const { port } = setup({ loans: [loan("444444", "s2", "s1")] });
  assert.deepEqual(cedulas(await port.getCashierPool("s1", W)), ["111111", "222222", "444444"]);
});

test("a person lent out is not counted twice and a cedula spelled with leading zeros still matches", async () => {
  const { port } = setup({ loans: [loan("111111", "s1", "s2")], rows: [...DIRECTORY, row("0111111", "Cajera", "s1")] });
  assert.deepEqual(cedulas(await port.getCashierPool("s1", W)), ["222222"]);
});

test("a failing loans read rejects the pool (never an empty or loan-less one)", async () => {
  const err = new Error("db down");
  const port = createStaffPort(
    { async list() { return { data: DIRECTORY }; } },
    { async getSede(id) { return { sedeId: id }; } },
    { async listActiveByWeek() { throw err; } },
  );
  await assert.rejects(port.getCashierPool("s1", W), (e) => e === err);
});

test("computeRun asks the staff port for the pool of the TARGET week", async () => {
  const { makeDeps, USER, WEEK } = await import("./api.helpers.js");
  const { createSugeridoService } = await import("../../src/modules/sugerido/sugerido.service.js");
  const ctx = makeDeps();
  const asked = [];
  ctx.deps.staffPort = { async getCashierPool(sedeId, weekStart) { asked.push([sedeId, weekStart]); return [{ cedula: "111111" }]; } };
  await createSugeridoService(ctx.deps).computeRun(USER, "s1", WEEK);
  assert.deepEqual(asked, [["s1", WEEK]]);
});
