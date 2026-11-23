import test from "node:test";
import assert from "node:assert/strict";

const { createHorariosService } = await import("../../src/modules/horarios/horarios.service.js");
const { teamOvertimeMinutes, TEAM_OVERTIME_HOURS } = await import("../../src/modules/horarios/domain/teamOvertime.js");

const SCHED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const W = "2031-01-06";
const DAYS = ["06", "07", "08", "09", "10", "11"].map((d) => `2031-01-${d}`);
const REST_DAY = "2031-01-12";
const access = { admin: { role: "admin", sedeIds: null }, planner: { role: "planner", sedeIds: ["copacabana"] } };
const user = { id: ADMIN };

// One person, six days of `hoursPerDay` h (no break) + a rest day. 7 h x 6 = 42 h = no overtime.
const person = (cedula, hoursPerDay) => [
  ...DAYS.map((fecha) => ({ cedula, fecha, tipo: "TRABAJO", startTime: "06:00", endTime: `${String(6 + hoursPerDay).padStart(2, "0")}:00`, breakMinutes: 0, lunchStart: null })),
  { cedula, fecha: REST_DAY, tipo: "DESCANSO", startTime: null, endTime: null, lunchStart: null },
];
// 42 h plus `overtimeHours` (at most 8) on the first day.
const rowsWithOvertime = (cedula, overtimeHours) => {
  const base = person(cedula, 7);
  base[0] = { ...base[0], endTime: `${String(13 + overtimeHours).padStart(2, "0")}:00` };
  return base;
};
const dbRow = (r, schedule = SCHED) => ({
  id: `row-${r.cedula}-${r.fecha}`, schedule_id: schedule, sede_id: "copacabana", siesa_code: "001", cedula: r.cedula, fecha: r.fecha,
  tipo: r.tipo, start_time: r.startTime ? `${r.startTime}:00` : null, end_time: r.endTime ? `${r.endTime}:00` : null,
  break_minutes: r.breakMinutes ?? 0, lunch_start: null, cargo: null, observacion: null,
});
const stored = (over = {}) => ({
  id: SCHED, sede_id: "copacabana", week_start: W, team_key: "CAJEROS", state: "BORRADOR", version: 1, published_by: null,
  published_at: null, created_by: ADMIN, created_at: "t0", updated_by: ADMIN, updated_at: "t1", ...over,
});

function setup({ schedule, rows = [], requests = [], overtimeFail = false, withOvertimeRepo = true } = {}) {
  const calls = [];
  const state = { schedule, rows: [...rows] };
  const repo = {
    async findSede(id) { return { sede_id: id }; },
    async findSchedule(sedeId, weekStart, teamKey) { return state.schedule && (state.schedule.team_key ?? "CAJEROS") === teamKey ? state.schedule : null; },
    async findPaidCutOverlapping() { return null; },
    async listShifts() { return state.rows; },
    async listShiftsByCedulas() { return []; },
    // Like the RPC: replaces the rows of the sent cedulas only.
    async saveWeek(args) {
      calls.push(["saveWeek", args]);
      state.rows = [...state.rows.filter((r) => !args.cedulas.includes(r.cedula)), ...args.shifts.map((s) => dbRow(s))];
      state.schedule = { ...state.schedule, version: state.schedule.version + 1 };
    },
    async publishWeek(args) {
      calls.push(["publishWeek", args]);
      state.schedule = { ...state.schedule, state: "PUBLICADO", version: state.schedule.version + 1 };
      return { noop: false };
    },
  };
  const overtimeRepo = withOvertimeRepo
    ? { async listByWeek(sedeId, weekStart) { calls.push(["listByWeek", sedeId, weekStart]); if (overtimeFail) throw new Error("db down"); return requests; } }
    : null;
  const profilesRepo = { async findById() { return null; } };
  return { calls, service: createHorariosService({ repo, profilesRepo, overtimeRepo, logger: { warn() {}, error() {} } }) };
}
const names = (calls, n) => calls.filter((c) => c[0] === n);
const notApproved = (details) => (e) => {
  assert.equal(e.statusCode, 422);
  assert.equal(e.code, "OVERTIME_NOT_APPROVED");
  if (details) assert.deepEqual(e.details, details);
  return true;
};
const approved = (hours) => ({ hours, status: "APROBADA" });
const payload = (rows, cedulas, expectedVersion = 2) => ({ expectedVersion, cedulas, shifts: rows.map((r) => ({ ...r, cargo: null, observacion: null })) });
const dbRows = (...people) => people.flat().map((r) => dbRow(r));

// ------------------------------------------------------------------ domain

test("teamOvertimeMinutes sums max(0, worked - 42 h) per person and subtracts breaks", () => {
  assert.equal(TEAM_OVERTIME_HOURS, 10);
  assert.equal(teamOvertimeMinutes(person("1", 7)), 0);
  assert.equal(teamOvertimeMinutes([...rowsWithOvertime("1", 3), ...rowsWithOvertime("2", 2)]), 5 * 60);
  // 6 x 8 h with a 60 min break = 42 h: no overtime.
  const withBreak = person("3", 8).map((r) => (r.tipo === "TRABAJO" ? { ...r, breakMinutes: 60 } : r));
  assert.equal(teamOvertimeMinutes(withBreak), 0);
  // A person under 42 h does not offset another one's overtime.
  assert.equal(teamOvertimeMinutes([...rowsWithOvertime("1", 3), ...person("2", 4)]), 3 * 60);
});

test("teamOvertimeMinutes counts a shift that crosses midnight", () => {
  const rows = [{ cedula: "1", fecha: W, tipo: "TRABAJO", startTime: "20:00", endTime: "06:00", breakMinutes: 0 }, ...person("1", 7).slice(1)];
  assert.equal(teamOvertimeMinutes(rows), 3 * 60); // 10 h instead of 7 h on the first day
});

// ------------------------------------------------------------------ publish

test("publish at exactly 10 h of overtime is allowed and reads no requests", async () => {
  const { service, calls } = setup({ schedule: stored(), rows: dbRows(rowsWithOvertime("1", 8), rowsWithOvertime("2", 2)) });
  const out = await service.publish(access.planner, user, "copacabana", W, { expectedVersion: 1 });
  assert.equal(out.schedule.state, "PUBLICADO");
  assert.equal(names(calls, "listByWeek").length, 0);
});

test("publish above 10 h is blocked with the budget details", async () => {
  const { service, calls } = setup({ schedule: stored(), rows: dbRows(rowsWithOvertime("1", 8), rowsWithOvertime("2", 3)) });
  await assert.rejects(
    service.publish(access.planner, user, "copacabana", W, { expectedVersion: 1 }),
    notApproved({ overtimeHours: 11, budgetHours: 10, approvedHours: 0, missingHours: 1, pending: false }),
  );
  assert.equal(names(calls, "publishWeek").length, 0);
});

test("admin is blocked too", async () => {
  const { service } = setup({ schedule: stored(), rows: dbRows(rowsWithOvertime("1", 8), rowsWithOvertime("2", 3)) });
  await assert.rejects(service.publish(access.admin, user, "copacabana", W, { expectedVersion: 1 }), notApproved());
});

test("approved hours raise the budget; exactly at the raised budget publishes", async () => {
  const rows = dbRows(rowsWithOvertime("1", 8), rowsWithOvertime("2", 8)); // 16 h
  const ok = setup({ schedule: stored(), rows, requests: [approved(6)] });
  assert.equal((await ok.service.publish(access.planner, user, "copacabana", W, { expectedVersion: 1 })).schedule.state, "PUBLICADO");
  const short = setup({ schedule: stored(), rows, requests: [approved(5.5)] });
  await assert.rejects(
    short.service.publish(access.planner, user, "copacabana", W, { expectedVersion: 1 }),
    notApproved({ overtimeHours: 16, budgetHours: 15.5, approvedHours: 5.5, missingHours: 0.5, pending: false }),
  );
});

test("PENDIENTE and RECHAZADA requests do not raise the budget; pending is reported", async () => {
  const requests = [{ hours: 6, status: "PENDIENTE" }, { hours: 9, status: "RECHAZADA" }];
  const { service } = setup({ schedule: stored(), rows: dbRows(rowsWithOvertime("1", 8), rowsWithOvertime("2", 8)), requests });
  await assert.rejects(
    service.publish(access.planner, user, "copacabana", W, { expectedVersion: 1 }),
    notApproved({ overtimeHours: 16, budgetHours: 10, approvedHours: 0, missingHours: 6, pending: true }),
  );
});

test("other teams are not controlled", async () => {
  const { service, calls } = setup({
    schedule: stored({ team_key: "CARGO:CARNICERO" }),
    rows: dbRows(rowsWithOvertime("1", 8), rowsWithOvertime("2", 8)),
  });
  const out = await service.publish(access.planner, user, "copacabana", W, { expectedVersion: 1 }, "CARGO:CARNICERO");
  assert.equal(out.schedule.state, "PUBLICADO");
  assert.equal(names(calls, "listByWeek").length, 0);
});

test("an already published week is returned as is even when over budget", async () => {
  const { service } = setup({ schedule: stored({ state: "PUBLICADO", version: 3 }), rows: dbRows(rowsWithOvertime("1", 8), rowsWithOvertime("2", 8)) });
  const out = await service.publish(access.planner, user, "copacabana", W, { expectedVersion: 1 });
  assert.equal(out.alreadyPublished, true);
});

test("a read error of the overtime requests propagates (fail closed)", async () => {
  const { service, calls } = setup({ schedule: stored(), rows: dbRows(rowsWithOvertime("1", 8), rowsWithOvertime("2", 8)), overtimeFail: true });
  await assert.rejects(service.publish(access.planner, user, "copacabana", W, { expectedVersion: 1 }), /db down/);
  assert.equal(names(calls, "publishWeek").length, 0);
});

test("without an overtime port nothing is approved", async () => {
  const { service } = setup({ schedule: stored(), rows: dbRows(rowsWithOvertime("1", 8), rowsWithOvertime("2", 3)), withOvertimeRepo: false });
  await assert.rejects(service.publish(access.planner, user, "copacabana", W, { expectedVersion: 1 }), notApproved());
});

// ------------------------------------------------------------------ save

test("saving a draft is never blocked, however much overtime it has", async () => {
  const { service, calls } = setup({ schedule: stored() });
  const rows = [...rowsWithOvertime("11111111", 8), ...rowsWithOvertime("22222222", 8)];
  await service.save(access.planner, user, "copacabana", W, payload(rows, ["11111111", "22222222"], 1));
  assert.equal(names(calls, "saveWeek").length, 1);
  assert.equal(names(calls, "listByWeek").length, 0);
});

const published = (extra = {}) =>
  setup({ schedule: stored({ state: "PUBLICADO", version: 2 }), rows: dbRows(rowsWithOvertime("11111111", 8), rowsWithOvertime("22222222", 2)), ...extra });

test("editing a published week: raising the overtime above the budget is blocked", async () => {
  const { service, calls } = published();
  await assert.rejects(
    service.save(access.planner, user, "copacabana", W, payload(rowsWithOvertime("22222222", 3), ["22222222"])),
    notApproved({ overtimeHours: 11, budgetHours: 10, approvedHours: 0, missingHours: 1, pending: false }),
  );
  assert.equal(names(calls, "saveWeek").length, 0);
});

test("editing a published week: cedulas that are not in the payload still count", async () => {
  const { service } = published();
  // Only the second person is sent; the first person's stored 8 h stay in the AFTER total.
  await assert.rejects(
    service.save(access.planner, user, "copacabana", W, payload(rowsWithOvertime("22222222", 4), ["22222222"])),
    notApproved({ overtimeHours: 12, budgetHours: 10, approvedHours: 0, missingHours: 2, pending: false }),
  );
});

test("editing a published week: raising within the approved budget is allowed", async () => {
  const { service, calls } = published({ requests: [approved(2)] });
  await service.save(access.planner, user, "copacabana", W, payload(rowsWithOvertime("22222222", 4), ["22222222"]));
  assert.equal(names(calls, "saveWeek").length, 1);
});

test("editing a published week that is already over: decreasing or staying equal is allowed, raising is not", async () => {
  const over = () => setup({ schedule: stored({ state: "PUBLICADO", version: 2 }), rows: dbRows(rowsWithOvertime("11111111", 8), rowsWithOvertime("22222222", 8)) }); // 16 h
  const down = over();
  await down.service.save(access.planner, user, "copacabana", W, payload(rowsWithOvertime("22222222", 5), ["22222222"]));
  assert.equal(names(down.calls, "saveWeek").length, 1);

  const equal = over();
  await equal.service.save(access.planner, user, "copacabana", W, payload(rowsWithOvertime("22222222", 8), ["22222222"]));
  assert.equal(names(equal.calls, "saveWeek").length, 1);
  assert.equal(names(equal.calls, "listByWeek").length, 0);

  const up = over();
  await assert.rejects(up.service.save(access.planner, user, "copacabana", W, payload(rowsWithOvertime("33333333", 1), ["33333333"])), notApproved());
});

test("editing a published week of another team is not controlled", async () => {
  const { service, calls } = setup({
    schedule: stored({ state: "PUBLICADO", version: 2, team_key: "CARGO:CARNICERO" }),
    rows: dbRows(rowsWithOvertime("11111111", 8), rowsWithOvertime("22222222", 8)),
  });
  await service.save(access.planner, user, "copacabana", W, payload(rowsWithOvertime("22222222", 8), ["22222222"]), "CARGO:CARNICERO");
  assert.equal(names(calls, "saveWeek").length, 1);
});

test("a read error while checking a published edit propagates and nothing is saved", async () => {
  const { service, calls } = published({ overtimeFail: true });
  await assert.rejects(service.save(access.planner, user, "copacabana", W, payload(rowsWithOvertime("22222222", 4), ["22222222"])), /db down/);
  assert.equal(names(calls, "saveWeek").length, 0);
});

test("editing a published week with a stale version skips the overtime check: saveWeek answers the version conflict", async () => {
  const { service, calls } = published({ overtimeFail: true });
  await service.save(access.planner, user, "copacabana", W, payload(rowsWithOvertime("22222222", 4), ["22222222"], 1));
  assert.equal(names(calls, "listByWeek").length, 0);
  assert.equal(names(calls, "saveWeek")[0][1].expectedVersion, 1);
});
