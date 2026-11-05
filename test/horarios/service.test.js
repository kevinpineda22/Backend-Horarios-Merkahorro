import test from "node:test";
import assert from "node:assert/strict";

const { createHorariosService } = await import("../../src/modules/horarios/horarios.service.js");
const { createHttpError } = await import("../../src/shared/http/HttpError.js");

const U = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const ADMIN = U("1"), PLANNER = U("2"), VIEWER = U("3");
const SCHED = U("a");
const W = "2031-01-06";
const DAYS = ["06", "07", "08", "09", "10", "11", "12"].map((d) => `2031-01-${d}`);
const NAMES = { [ADMIN]: "Ana Admin", [PLANNER]: "Paula Planner", [VIEWER]: "Vera Viewer" };

const access = {
  admin: { role: "admin", sedeIds: null },
  planner: { role: "planner", sedeIds: ["copacabana"] },
  plannerOther: { role: "planner", sedeIds: ["las-vegas"] },
  viewer: { role: "viewer", sedeIds: ["copacabana"] },
};
const user = (id) => ({ id });

const work = (cedula, fecha, startTime = "08:00", endTime = "12:00", extra = {}) =>
  ({ cedula, fecha, tipo: "TRABAJO", startTime, endTime, breakMinutes: 0, lunchStart: null, cargo: null, observacion: null, ...extra });
const rest = (cedula, fecha, tipo = "DESCANSO") =>
  ({ cedula, fecha, tipo, startTime: null, endTime: null, lunchStart: null, cargo: null, observacion: null });

const dbRow = (r, sede = "copacabana", schedule = SCHED) => ({
  id: `row-${r.cedula}-${r.fecha}`, schedule_id: schedule, sede_id: sede, siesa_code: "001", cedula: r.cedula, fecha: r.fecha,
  tipo: r.tipo, start_time: r.startTime ? `${r.startTime}:00` : null, end_time: r.endTime ? `${r.endTime}:00` : null,
  break_minutes: r.breakMinutes ?? 0, lunch_start: r.lunchStart ? `${r.lunchStart}:00` : null, cargo: r.cargo ?? null,
  observacion: r.observacion ?? null, updated_by: ADMIN, updated_at: "t1",
});

function fakes({ schedule = null, rows = [], neighbors = [], sedes = ["copacabana", "las-vegas"] } = {}) {
  const state = { schedule, rows: [...rows] };
  const calls = [];
  const repo = {
    calls,
    state,
    async findSede(id) { calls.push(["findSede", id]); return sedes.includes(id) ? { sede_id: id, siesa_code: "001" } : null; },
    async findSchedule() { calls.push(["findSchedule"]); return state.schedule; },
    async listShifts() { calls.push(["listShifts"]); return state.rows; },
    async listShiftsByCedulas(args) {
      calls.push(["listShiftsByCedulas", args]);
      return neighbors.filter((n) => args.cedulas.includes(n.cedula));
    },
    async saveWeek(args) {
      calls.push(["saveWeek", args]);
      if (args.expectedVersion !== (state.schedule?.version ?? 0)) {
        const e = createHttpError(409, "stale", "VERSION_CONFLICT");
        e.details = { currentVersion: state.schedule?.version ?? 0 };
        throw e;
      }
      state.schedule = {
        id: SCHED, sede_id: args.sedeId, week_start: args.weekStart, state: state.schedule?.state ?? "BORRADOR",
        version: (state.schedule?.version ?? 0) + 1, published_by: state.schedule?.published_by ?? null,
        published_at: state.schedule?.published_at ?? null, created_by: args.actor, created_at: "t0", updated_by: args.actor, updated_at: "t2",
      };
      state.rows = [...state.rows.filter((r) => !args.cedulas.includes(r.cedula)), ...args.shifts.map((s) => dbRow(s))];
      return { id: SCHED, version: state.schedule.version };
    },
    async publishWeek(args) {
      calls.push(["publishWeek", args]);
      state.schedule = { ...state.schedule, state: "PUBLICADO", version: state.schedule.version + 1, published_by: args.actor, published_at: "t3", updated_by: args.actor };
      return { id: SCHED, noop: false };
    },
    async listHistory(args) {
      calls.push(["listHistory", args]);
      return [{ id: 2, shift_id: "s1", cedula: "11111111", fecha: W, action: "EDITAR", schedule_version: 2, actor: PLANNER, at: "t2", before: {}, after: {} }];
    },
  };
  const profilesRepo = { async findById(id) { return NAMES[id] ? { user_id: id, nombre: NAMES[id], correo: "x@x.co" } : null; } };
  return { repo, profilesRepo, service: createHorariosService({ repo, profilesRepo }) };
}
const stored = (over = {}) => ({
  id: SCHED, sede_id: "copacabana", week_start: W, state: "BORRADOR", version: 1, published_by: null, published_at: null,
  created_by: ADMIN, created_at: "t0", updated_by: PLANNER, updated_at: "t1", ...over,
});
const code = (status, c) => (e) => e.statusCode === status && e.code === c && e.expose === true;
const called = (repo, name) => repo.calls.filter((c) => c[0] === name);

// ------------------------------------------------------------------ get

test("get on a week that was never saved answers version 0, BORRADOR and no shifts", async () => {
  const { service } = fakes();
  const out = await service.get(access.planner, "copacabana", W);
  assert.deepEqual(out, {
    schedule: { sedeId: "copacabana", weekStart: W, state: "BORRADOR", version: 0, updatedBy: null, updatedByName: null, updatedAt: null, publishedBy: null, publishedByName: null, publishedAt: null },
    shifts: [],
    permissions: { canEdit: true, canPublish: true },
  });
});

test("get returns normalized shifts, names and the siesa snapshot", async () => {
  const { service } = fakes({ schedule: stored({ state: "PUBLICADO", published_by: ADMIN, published_at: "t9" }), rows: [dbRow(work("11111111", W, "08:00", "24:00", { breakMinutes: 60, lunchStart: "12:00" }))] });
  const out = await service.get(access.admin, "copacabana", W);
  assert.equal(out.schedule.updatedByName, "Paula Planner");
  assert.equal(out.schedule.publishedByName, "Ana Admin");
  assert.deepEqual(out.shifts[0], {
    id: `row-11111111-${W}`, siesaCode: "001", cedula: "11111111", fecha: W, tipo: "TRABAJO", startTime: "08:00", endTime: "24:00",
    breakMinutes: 60, lunchStart: "12:00", cargo: null, observacion: null,
  });
});

test("permissions follow the role and the sede scope", async () => {
  const perms = async (a) => (await fakes().service.get(a, "copacabana", W)).permissions;
  assert.deepEqual(await perms(access.admin), { canEdit: true, canPublish: true });
  assert.deepEqual(await perms(access.planner), { canEdit: true, canPublish: true });
  assert.deepEqual(await perms(access.viewer), { canEdit: false, canPublish: false });
});

test("every operation answers 404 SEDE_NOT_FOUND for an unknown sede", async () => {
  const { service, repo } = fakes();
  const body = { expectedVersion: 0, cedulas: ["11111111"], shifts: [] };
  await assert.rejects(service.get(access.admin, "nope", W), code(404, "SEDE_NOT_FOUND"));
  await assert.rejects(service.save(access.admin, user(ADMIN), "nope", W, body), code(404, "SEDE_NOT_FOUND"));
  await assert.rejects(service.publish(access.admin, user(ADMIN), "nope", W, { expectedVersion: 1 }), code(404, "SEDE_NOT_FOUND"));
  await assert.rejects(service.history(access.admin, "nope", W, 50), code(404, "SEDE_NOT_FOUND"));
  assert.equal(called(repo, "saveWeek").length + called(repo, "publishWeek").length, 0);
});

// ------------------------------------------------------------------ save

test("viewers and planners of another sede cannot save or publish", async () => {
  const body = { expectedVersion: 0, cedulas: ["11111111"], shifts: [] };
  for (const [a, c] of [[access.viewer, "FORBIDDEN_ROLE"], [access.plannerOther, "FORBIDDEN_SEDE"]]) {
    const { service, repo } = fakes({ schedule: stored() });
    await assert.rejects(service.save(a, user(VIEWER), "copacabana", W, body), code(403, c));
    await assert.rejects(service.publish(a, user(VIEWER), "copacabana", W, { expectedVersion: 1 }), code(403, c));
    assert.equal(called(repo, "saveWeek").length + called(repo, "publishWeek").length, 0);
  }
});

test("save normalizes the payload (default break), sends the actor and returns schedule, shifts and warnings", async () => {
  const { service, repo } = fakes();
  const out = await service.save(access.planner, user(PLANNER), "copacabana", W, {
    expectedVersion: 0, cedulas: ["11111111"], shifts: [{ ...work("11111111", W, "08:00", "17:00"), breakMinutes: undefined }],
  });
  const [, args] = called(repo, "saveWeek")[0];
  assert.equal(args.shifts[0].breakMinutes, 60);
  assert.equal(args.actor, PLANNER);
  assert.deepEqual([args.sedeId, args.weekStart, args.expectedVersion, args.cedulas], ["copacabana", W, 0, ["11111111"]]);
  assert.equal(out.schedule.version, 1);
  assert.equal(out.schedule.updatedByName, "Paula Planner");
  assert.equal(out.shifts.length, 1);
  assert.ok(Array.isArray(out.warnings));
});

test("an invalid payload is a 400 INVALID_SHIFTS and nothing is written", async () => {
  const { service, repo } = fakes();
  await assert.rejects(
    service.save(access.admin, user(ADMIN), "copacabana", W, { expectedVersion: 0, cedulas: ["11111111"], shifts: [work("11111111", W, "08:00", "09:00", { breakMinutes: undefined })] }),
    code(400, "INVALID_SHIFTS"),
  );
  assert.equal(called(repo, "saveWeek").length, 0);
});

test("publish blockers become NON-blocking warnings on save, and the save still happens", async () => {
  const { service, repo } = fakes();
  const shifts = DAYS.map((d) => work("11111111", d)); // 7 days, no rest
  const out = await service.save(access.admin, user(ADMIN), "copacabana", W, { expectedVersion: 0, cedulas: ["11111111"], shifts });
  assert.equal(called(repo, "saveWeek").length, 1);
  assert.deepEqual(out.warnings.find((w) => w.code === "DESCANSO_SEMANAL_OBLIGATORIO"), { code: "DESCANSO_SEMANAL_OBLIGATORIO", cedula: "11111111", blocking: false });
});

test("neighbor schedules of other sedes count toward the hours check", async () => {
  const neighbors = DAYS.slice(0, 5).map((d) => dbRow(work("11111111", d, "13:00", "21:00"), "las-vegas", U("b")));
  const { service, repo } = fakes({ neighbors });
  const shifts = [...DAYS.slice(0, 5).map((d) => work("11111111", d, "08:00", "12:00")), rest("11111111", DAYS[6])];
  const out = await service.save(access.admin, user(ADMIN), "copacabana", W, { expectedVersion: 0, cedulas: ["11111111"], shifts });
  const w = out.warnings.find((x) => x.code === "LIMITE_HORAS_EXTRA_SEMANAL");
  assert.equal(w.workedMinutes, 3600);
  assert.equal(w.blocking, false);
  const [, q] = called(repo, "listShiftsByCedulas")[0];
  assert.deepEqual([q.from, q.to], ["2031-01-05", "2031-01-13"]);
});

test("a stale expectedVersion surfaces the repo's 409 with the current version", async () => {
  const { service } = fakes({ schedule: stored({ version: 3 }) });
  await assert.rejects(
    service.save(access.admin, user(ADMIN), "copacabana", W, { expectedVersion: 1, cedulas: ["11111111"], shifts: [] }),
    (e) => code(409, "VERSION_CONFLICT")(e) && e.details.currentVersion === 3,
  );
});

test("an existing schedule is excluded from the neighbor query", async () => {
  const { service, repo } = fakes({ schedule: stored() });
  await service.save(access.admin, user(ADMIN), "copacabana", W, { expectedVersion: 1, cedulas: ["11111111"], shifts: [work("11111111", W)] });
  assert.equal(called(repo, "listShiftsByCedulas")[0][1].excludeScheduleId, SCHED);
});

// ------------------------------------------------------------------ publish

const ready = () => [...DAYS.slice(0, 6).map((d) => work("11111111", d)), rest("11111111", DAYS[6])].map((r) => dbRow(r));

test("publish of a week that was never saved is a 404", async () => {
  const { service } = fakes();
  await assert.rejects(service.publish(access.admin, user(ADMIN), "copacabana", W, { expectedVersion: 1 }), code(404, "SCHEDULE_NOT_FOUND"));
});

test("publish of an already PUBLICADO week is a 200 no-op that never computes blockers", async () => {
  const { service, repo } = fakes({ schedule: stored({ state: "PUBLICADO", version: 5, published_by: ADMIN, published_at: "t9" }), rows: ready() });
  const out = await service.publish(access.admin, user(ADMIN), "copacabana", W, { expectedVersion: 1 }); // stale on purpose
  assert.equal(out.alreadyPublished, true);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.schedule.state, "PUBLICADO");
  for (const name of ["listShifts", "listShiftsByCedulas", "publishWeek", "saveWeek"]) assert.equal(called(repo, name).length, 0, name);
});

test("publish with a stale version is a 409 carrying the current version", async () => {
  const { service, repo } = fakes({ schedule: stored({ version: 4 }), rows: ready() });
  await assert.rejects(
    service.publish(access.admin, user(ADMIN), "copacabana", W, { expectedVersion: 2 }),
    (e) => code(409, "VERSION_CONFLICT")(e) && e.details.currentVersion === 4,
  );
  assert.equal(called(repo, "publishWeek").length, 0);
});

test("publish with blockers is a 422 PUBLISH_BLOCKED listing every blocker and writes nothing", async () => {
  const rows = [...DAYS.map((d) => work("11111111", d)), ...DAYS.map((d) => work("22222222", d)), ...DAYS.slice(0, 6).map((d) => work("33333333", d)), rest("33333333", DAYS[6])].map((r) => dbRow(r));
  const { service, repo } = fakes({ schedule: stored(), rows });
  await assert.rejects(service.publish(access.admin, user(ADMIN), "copacabana", W, { expectedVersion: 1 }), (e) => {
    assert.ok(code(422, "PUBLISH_BLOCKED")(e));
    assert.deepEqual(e.details.blockers.map((b) => [b.cedula, b.code]), [["11111111", "DESCANSO_SEMANAL_OBLIGATORIO"], ["22222222", "DESCANSO_SEMANAL_OBLIGATORIO"]]);
    return true;
  });
  assert.equal(called(repo, "publishWeek").length, 0);
});

test("hours worked in another sede block the publication", async () => {
  const neighbors = DAYS.slice(0, 6).map((d) => dbRow(work("11111111", d, "13:00", "23:00"), "las-vegas", U("b")));
  const { service } = fakes({ schedule: stored(), rows: ready(), neighbors });
  await assert.rejects(service.publish(access.admin, user(ADMIN), "copacabana", W, { expectedVersion: 1 }), (e) =>
    e.code === "PUBLISH_BLOCKED" && e.details.blockers.some((b) => b.code === "LIMITE_HORAS_EXTRA_SEMANAL"));
});

test("a clean publish calls the RPC with the expected version and returns the new state", async () => {
  const { service, repo } = fakes({ schedule: stored(), rows: ready() });
  const out = await service.publish(access.planner, user(PLANNER), "copacabana", W, { expectedVersion: 1 });
  assert.deepEqual(called(repo, "publishWeek")[0][1], { sedeId: "copacabana", weekStart: W, expectedVersion: 1, actor: PLANNER });
  assert.equal(out.alreadyPublished, false);
  assert.equal(out.schedule.state, "PUBLICADO");
  assert.equal(out.schedule.version, 2);
  assert.equal(out.schedule.publishedByName, "Paula Planner");
});

// ------------------------------------------------------------------ history

test("history is newest-first, resolves actor names and is empty for an unsaved week", async () => {
  const { service, repo } = fakes({ schedule: stored() });
  const out = await service.history(access.viewer, "copacabana", W, 25);
  assert.deepEqual(called(repo, "listHistory")[0][1], { scheduleId: SCHED, limit: 25 });
  assert.deepEqual(out.items[0], {
    id: 2, action: "EDITAR", shiftId: "s1", cedula: "11111111", fecha: W, scheduleVersion: 2, actor: PLANNER, actorName: "Paula Planner", at: "t2", before: {}, after: {},
  });
  const empty = await fakes().service.history(access.viewer, "copacabana", W, 25);
  assert.deepEqual(empty, { items: [] });
});

test("get and history re-check sede access: 403 FORBIDDEN_SEDE before touching the repo", async () => {
  const { service, repo } = fakes({ schedule: stored() });
  await assert.rejects(service.get(access.plannerOther, "copacabana", W), code(403, "FORBIDDEN_SEDE"));
  await assert.rejects(service.history(access.plannerOther, "copacabana", W, 25), code(403, "FORBIDDEN_SEDE"));
  await assert.rejects(service.get(null, "copacabana", W), code(403, "FORBIDDEN_SEDE"));
  assert.equal(repo.calls.length, 0);
});
