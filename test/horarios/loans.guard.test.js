import test from "node:test";
import assert from "node:assert/strict";

const { createHorariosService } = await import("../../src/modules/horarios/horarios.service.js");
const { createHorariosRepo } = await import("../../src/modules/horarios/horarios.supabase.js");

const U = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const PLANNER = U("2");
const W = "2031-01-06";
const SCHED = U("a");
const planner = { role: "planner", sedeIds: ["copacabana"] };

const work = (cedula, fecha) => ({ cedula, fecha, tipo: "TRABAJO", startTime: "08:00", endTime: "12:00", breakMinutes: 0, lunchStart: null, cargo: null, observacion: null });

function setup({ loans = [], loansRepo, noLoans = false } = {}) {
  const calls = [];
  const repo = {
    async findSede(id) { return { sede_id: id, siesa_code: "001", nombre: id === "las-vegas" ? "Las Vegas" : "Copacabana" }; },
    async findSchedule() { return calls.some((c) => c[0] === "saveWeek") ? { id: SCHED, sede_id: "copacabana", week_start: W, team_key: "CAJEROS", state: "BORRADOR", version: 1 } : null; },
    async listShiftsByCedulas() { return []; },
    async listShifts() { return []; },
    async findPaidCutOverlapping() { return null; },
    async saveWeek(args) { calls.push(["saveWeek", args]); return { id: SCHED, version: 1 }; },
  };
  const loanCalls = [];
  const repoLoans = loansRepo ?? {
    async listActiveLentOut(args) {
      loanCalls.push(args);
      return loans.filter((l) => l.homeSedeId === args.sedeId && l.weekStart === args.weekStart && args.cedulas.includes(l.cedula));
    },
  };
  const service = createHorariosService({ repo, profilesRepo: { async findById() { return null; } }, loansRepo: noLoans ? null : repoLoans, logger: null });
  return { service, calls, loanCalls };
}
const save = (service, shifts, cedulas = [...new Set(shifts.map((s) => s.cedula))], week = W) =>
  service.save(planner, { id: PLANNER }, "copacabana", week, { expectedVersion: 0, cedulas, shifts });
const LENT = { cedula: "11111111", homeSedeId: "copacabana", hostSedeId: "las-vegas", weekStart: W };

test("saving rows for somebody lent OUT of this sede that week is 409 EMPLOYEE_LENT naming the host sede; nothing is written", async () => {
  const { service, calls } = setup({ loans: [LENT] });
  await assert.rejects(save(service, [work("11111111", W), work("22222222", W)]), (e) => {
    assert.equal(e.statusCode, 409);
    assert.equal(e.code, "EMPLOYEE_LENT");
    assert.match(e.message, /Las Vegas/);
    assert.deepEqual(e.details, { loans: [{ cedula: "11111111", hostSedeId: "las-vegas" }] });
    return true;
  });
  assert.equal(calls.length, 0);
});

test("only the cedulas in the payload are checked, for that sede and that week", async () => {
  const { service, calls, loanCalls } = setup({ loans: [LENT] });
  await save(service, [work("22222222", W)]);
  assert.equal(calls.length, 1, "somebody else's loan does not block");
  assert.deepEqual(loanCalls[0], { sedeId: "copacabana", weekStart: W, cedulas: ["22222222"] });
  const other = setup({ loans: [{ ...LENT, weekStart: "2031-01-13" }] });
  await save(other.service, [work("11111111", W)]);
  assert.equal(other.calls.length, 1, "a loan of another week does not block");
});

test("clearing a lent person (listed without rows) is allowed, and with no rows the loans are not even read", async () => {
  const { service, calls, loanCalls } = setup({ loans: [LENT] });
  await save(service, [], ["11111111"]);
  assert.equal(calls.length, 1);
  assert.equal(loanCalls.length, 0);
});

test("without a loans repo the save behaves as before; a failing loans read rejects the save", async () => {
  const { service, calls } = setup({ loans: [LENT], noLoans: true });
  await save(service, [work("11111111", W)]);
  assert.equal(calls.length, 1);
  const boom = new Error("db down");
  const failing = setup({ loansRepo: { async listActiveLentOut() { throw boom; } } });
  await assert.rejects(save(failing.service, [work("11111111", W)]), (e) => e === boom);
  assert.equal(failing.calls.length, 0);
});

test("horarios repo.hasShiftsInSedeWeek: any tipo, one sede, the week range, limit 1", async () => {
  const log = [];
  const builder = (result) =>
    new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve(result).then(res, rej);
        return (...args) => (log.push([prop, ...args]), builder(result));
      },
    });
  const repo = createHorariosRepo({ from: (t) => (log.push(["from", t]), builder({ data: [{ id: 1 }], error: null })) });
  assert.equal(await repo.hasShiftsInSedeWeek({ cedula: "111111", sedeId: "s1", from: W, to: "2031-01-12" }), true);
  const has = (...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));
  assert.ok(has("from", "shifts"));
  assert.ok(has("eq", "cedula", "111111"));
  assert.ok(has("eq", "sede_id", "s1"));
  assert.ok(has("gte", "fecha", W));
  assert.ok(has("lte", "fecha", "2031-01-12"));
  assert.ok(!log.some((c) => c[1] === "tipo"), "no tipo filter");
  const empty = createHorariosRepo({ from: () => builder({ data: [], error: null }) });
  assert.equal(await empty.hasShiftsInSedeWeek({ cedula: "111111", sedeId: "s1", from: W, to: W }), false);
});
