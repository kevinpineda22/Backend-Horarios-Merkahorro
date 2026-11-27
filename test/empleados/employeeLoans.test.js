import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createEmpleadosRouter, loanBodySchema, loansQuerySchema, loanParamsSchema } = await import("../../src/modules/empleados/empleados.routes.js");
const { createEmpleadosService } = await import("../../src/modules/empleados/empleados.service.js");
const { createEmployeeLoansRepo, LoanExistsError, LoanSedeMissingError } = await import("../../src/modules/empleados/employeeLoans.supabase.js");
const { createEmployeeLoansService } = await import("../../src/modules/empleados/employeeLoans.service.js");
const { createHttpError } = await import("../../src/shared/http/HttpError.js");

const code = (status, c) => (e) => e.statusCode === status && e.code === c && e.expose === true;

const W = "2031-01-06"; // Monday of the current week in the tests
const NEXT = "2031-01-13";
const PAST = "2030-12-30";
const NOW = () => new Date("2031-01-08T15:00:00Z"); // Wednesday 10:00 in Bogota
const ID1 = "11111111-1111-4111-8111-111111111111";

const ADMIN = { role: "admin", sedeIds: null };
const PLANNER_HOME = { role: "planner", sedeIds: ["s1"] };
const PLANNER_HOST = { role: "planner", sedeIds: ["s2"] };
const PLANNER_ALL = { role: "planner", sedeIds: null };
const VIEWER_HOST = { role: "viewer", sedeIds: ["s2"] };
const VIEWER_OTHER = { role: "viewer", sedeIds: ["s3"] };
const USER = { id: "u-planner" };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
test("query: weekStart must be a real Monday", () => {
  assert.equal(loansQuerySchema.safeParse({ weekStart: W }).success, true);
  for (const weekStart of [undefined, "", "2031-01-07", "2031-02-30", "06/01/2031", 5]) {
    assert.equal(loansQuerySchema.safeParse({ weekStart }).success, false, String(weekStart));
  }
});

test("body: cedula, hostSedeId and a Monday are mandatory; motivo is trimmed, optional and at most 200 characters", () => {
  assert.deepEqual(loanBodySchema.parse({ cedula: "00111111", hostSedeId: " s2 ", weekStart: W, motivo: " Apoyo " }), {
    cedula: "00111111", hostSedeId: "s2", weekStart: W, motivo: "Apoyo",
  });
  assert.equal(loanBodySchema.parse({ cedula: "111111", hostSedeId: "s2", weekStart: W }).motivo, null);
  assert.equal(loanBodySchema.parse({ cedula: "111111", hostSedeId: "s2", weekStart: W, motivo: "  " }).motivo, null);
  const ok = { cedula: "111111", hostSedeId: "s2", weekStart: W };
  for (const bad of [{ cedula: "12" }, { hostSedeId: "" }, { hostSedeId: undefined }, { weekStart: "2031-01-07" }, { weekStart: undefined }, { motivo: "x".repeat(201) }]) {
    assert.equal(loanBodySchema.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
  }
});

test("params: the id is a uuid", () => {
  assert.equal(loanParamsSchema.safeParse({ id: ID1 }).success, true);
  assert.equal(loanParamsSchema.safeParse({ id: "abc" }).success, false);
});

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------
function fakeClient(script = {}) {
  const log = [];
  const builder = (result) =>
    new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve(result).then(res, rej);
        return (...args) => (log.push([prop, ...args]), builder(result));
      },
    });
  const queue = (script.results ?? []).slice();
  return { log, client: { from: (t) => (log.push(["from", t]), builder(queue.length ? queue.shift() : { data: null, error: null })) } };
}
const has = (log, ...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));
const ROW = { id: ID1, cedula: "111111", home_sede_id: "s1", host_sede_id: "s2", week_start: W, motivo: "Apoyo", created_by: "u-admin", created_at: "2031-01-07T10:00:00+00:00" };
const LOAN = { id: ID1, cedula: "111111", homeSedeId: "s1", hostSedeId: "s2", weekStart: W, motivo: "Apoyo", createdBy: "u-admin", createdAt: "2031-01-07T10:00:00.000Z" };

test("repo.listActiveByWeek: ONE query, active rows of that week only, camelCase", async () => {
  const { log, client } = fakeClient({ results: [{ data: [ROW], error: null }] });
  assert.deepEqual(await createEmployeeLoansRepo(client).listActiveByWeek(W), [LOAN]);
  assert.equal(log.filter((c) => c[0] === "from").length, 1);
  assert.ok(has(log, "from", "employee_loans"));
  assert.ok(has(log, "is", "revoked_at", null));
  assert.ok(has(log, "eq", "week_start", W));
});

test("repo.listActiveLentOut: filters by home sede and cedulas; no cedulas means no query", async () => {
  const { log, client } = fakeClient({ results: [{ data: [ROW], error: null }] });
  const repo = createEmployeeLoansRepo(client);
  assert.deepEqual(await repo.listActiveLentOut({ sedeId: "s1", weekStart: W, cedulas: ["111111"] }), [LOAN]);
  assert.ok(has(log, "eq", "home_sede_id", "s1"));
  assert.ok(has(log, "in", "cedula", ["111111"]));
  const none = fakeClient();
  assert.deepEqual(await createEmployeeLoansRepo(none.client).listActiveLentOut({ sedeId: "s1", weekStart: W, cedulas: [] }), []);
  assert.equal(none.log.length, 0);
});

test("repo.findActiveById / findActive: null when there is no active row", async () => {
  const { client } = fakeClient({ results: [{ data: null, error: null }, { data: ROW, error: null }] });
  const repo = createEmployeeLoansRepo(client);
  assert.equal(await repo.findActiveById(ID1), null);
  assert.deepEqual(await repo.findActive("111111", W), LOAN);
});

test("repo.create: inserts the active row; a unique violation is LoanExistsError, a foreign key one LoanSedeMissingError", async () => {
  const ok = fakeClient({ results: [{ data: ROW, error: null }] });
  const created = await createEmployeeLoansRepo(ok.client).create({ cedula: "111111", homeSedeId: "s1", hostSedeId: "s2", weekStart: W, motivo: "Apoyo", userId: "u-admin" });
  assert.deepEqual(created, LOAN);
  assert.ok(has(ok.log, "insert", { cedula: "111111", home_sede_id: "s1", host_sede_id: "s2", week_start: W, motivo: "Apoyo", created_by: "u-admin" }));
  const args = { cedula: "111111", homeSedeId: "s1", hostSedeId: "s2", weekStart: W, userId: "u" };
  const dup = fakeClient({ results: [{ data: null, error: { code: "23505" } }] });
  await assert.rejects(createEmployeeLoansRepo(dup.client).create(args), LoanExistsError);
  const fk = fakeClient({ results: [{ data: null, error: { code: "23503" } }] });
  await assert.rejects(createEmployeeLoansRepo(fk.client).create(args), LoanSedeMissingError);
  const boom = new Error("db down");
  await assert.rejects(createEmployeeLoansRepo(fakeClient({ results: [{ data: null, error: boom }] }).client).create(args), (e) => e === boom);
});

test("repo.revoke: soft update of the ACTIVE row with the actor and the clock; null when nothing was revoked", async () => {
  const hit = fakeClient({ results: [{ data: [ROW], error: null }] });
  const repo = createEmployeeLoansRepo(hit.client, { now: () => new Date("2031-01-08T00:00:00Z") });
  assert.deepEqual(await repo.revoke({ id: ID1, userId: "u-admin" }), LOAN);
  assert.ok(has(hit.log, "update", { revoked_by: "u-admin", revoked_at: "2031-01-08T00:00:00.000Z" }));
  assert.ok(has(hit.log, "is", "revoked_at", null));
  assert.ok(!hit.log.some((c) => c[0] === "delete"));
  const miss = fakeClient({ results: [{ data: [], error: null }] });
  assert.equal(await createEmployeeLoansRepo(miss.client).revoke({ id: ID1, userId: "u" }), null);
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
const DIRECTORY = {
  111111: { cedula: "111111", nombre: "Ana Cajera", cargo: "Cajera", sedeId: "s1" },
  222222: { cedula: "222222", nombre: "Luis Otro", cargo: "Cajero", sedeId: "s3" },
  333333: { cedula: "333333", nombre: "Sin Sede", cargo: "Cajero", sedeId: null },
};

const lid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fakeLoansRepo(initial = []) {
  const state = { rows: initial.map((l) => ({ ...l })), seq: 0, calls: [] };
  return {
    state,
    async listActiveByWeek(week) { return state.rows.filter((l) => l.weekStart === week && !l.revokedAt).map((l) => ({ ...l })); },
    async findActive(cedula, week) { return state.rows.find((l) => l.cedula === cedula && l.weekStart === week && !l.revokedAt) ?? null; },
    async findActiveById(id) { return state.rows.find((l) => l.id === id && !l.revokedAt) ?? null; },
    async create(args) {
      state.calls.push(["create", args]);
      if (args.throws) throw args.throws;
      const row = { id: lid(++state.seq), cedula: args.cedula, homeSedeId: args.homeSedeId, hostSedeId: args.hostSedeId, weekStart: args.weekStart, motivo: args.motivo, createdBy: args.userId, createdAt: "2031-01-08T15:00:00.000Z" };
      state.rows.push(row);
      return { ...row };
    },
    async revoke({ id, userId }) {
      state.calls.push(["revoke", { id, userId }]);
      const row = state.rows.find((l) => l.id === id && !l.revokedAt);
      if (!row) return null;
      row.revokedAt = "now";
      return { ...row };
    },
  };
}

function setup({ loans = [], shifts = [], mappedSedes = ["s1", "s2", "s3"], throwOnCreate = null, shiftsAppearAfterCreate = false } = {}) {
  const repo = fakeLoansRepo(loans);
  if (throwOnCreate) {
    const create = repo.create;
    repo.create = (args) => create({ ...args, throws: throwOnCreate });
  }
  const shiftCalls = [];
  let created = false;
  const baseCreate = repo.create;
  repo.create = async (args) => { const row = await baseCreate(args); created = true; return row; };
  const service = createEmployeeLoansService({
    repo,
    empleadosService: { async findByCedula(c) { return DIRECTORY[c] ?? null; } },
    sedeRepo: {
      async getSede(id) {
        if (!mappedSedes.includes(id)) throw createHttpError(404, "no mapeada", "SEDE_NOT_MAPPED");
        return { sedeId: id };
      },
      async listSedes() { return [{ sedeId: "s1", nombre: "Centro" }, { sedeId: "s2", nombre: "Norte" }]; },
    },
    shiftsRepo: {
      async hasShiftsInSedeWeek(args) {
        shiftCalls.push(args);
        if (shiftsAppearAfterCreate && created && args.sedeId === "s1") return true;
        return shifts.some((s) => s.cedula === args.cedula && s.sedeId === args.sedeId && s.fecha >= args.from && s.fecha <= args.to);
      },
    },
    now: NOW,
  });
  return { service, repo, shiftCalls };
}
const body = (over = {}) => ({ cedula: "111111", hostSedeId: "s2", weekStart: W, motivo: "Apoyo", ...over });

test("create: a planner of the HOME sede lends her; the DTO carries names and the loan is stored with the actor", async () => {
  const { service, repo } = setup();
  const out = await service.create(PLANNER_HOME, USER, body());
  assert.deepEqual(out, {
    id: lid(1), cedula: "111111", nombre: "Ana Cajera", cargo: "Cajera", homeSedeId: "s1", homeSedeNombre: "Centro",
    hostSedeId: "s2", hostSedeNombre: "Norte", weekStart: W, motivo: "Apoyo", createdAt: "2031-01-08T15:00:00.000Z",
  });
  assert.deepEqual(repo.state.calls[0][1], { cedula: "111111", homeSedeId: "s1", hostSedeId: "s2", weekStart: W, motivo: "Apoyo", userId: USER.id });
});

test("create: admin and an all-sedes planner can lend anybody; a future week is fine", async () => {
  for (const access of [ADMIN, PLANNER_ALL]) {
    const { service } = setup();
    assert.equal((await service.create(access, USER, body({ weekStart: NEXT }))).weekStart, NEXT);
  }
});

test("create: authorization is over the HOME sede, never the host", async () => {
  const { service, repo } = setup();
  await assert.rejects(service.create(PLANNER_HOST, USER, body()), code(403, "FORBIDDEN_SEDE"));
  await assert.rejects(service.create(VIEWER_HOST, USER, body()), code(403, "FORBIDDEN_ROLE"));
  await assert.rejects(service.create(null, USER, body()), code(403, "FORBIDDEN_ROLE"));
  assert.equal(repo.state.calls.length, 0);
});

test("create: unknown person 404; person without sede 409", async () => {
  const { service } = setup();
  await assert.rejects(service.create(ADMIN, USER, body({ cedula: "999999" })), code(404, "EMPLEADO_NOT_FOUND"));
  await assert.rejects(service.create(ADMIN, USER, body({ cedula: "333333" })), code(409, "EMPLEADO_SIN_SEDE"));
});

test("create: host equal to home 400; host not mapped 404; past week 400", async () => {
  const { service } = setup();
  await assert.rejects(service.create(ADMIN, USER, body({ hostSedeId: "s1" })), code(400, "LOAN_SAME_SEDE"));
  await assert.rejects(service.create(ADMIN, USER, body({ hostSedeId: "zzz" })), code(404, "SEDE_NOT_MAPPED"));
  await assert.rejects(service.create(ADMIN, USER, body({ weekStart: PAST })), code(400, "LOAN_WEEK_PAST"));
});

test("create: the current week (Monday already gone, Bogota time) is allowed; Sunday night still belongs to it", async () => {
  const sundayNight = new Date("2031-01-13T03:00:00Z"); // Sunday 22:00 in Bogota
  const late = createEmployeeLoansService({
    repo: fakeLoansRepo(),
    empleadosService: { async findByCedula(c) { return DIRECTORY[c] ?? null; } },
    sedeRepo: { async getSede() { return {}; }, async listSedes() { return []; } },
    shiftsRepo: { async hasShiftsInSedeWeek() { return false; } },
    now: () => sundayNight,
  });
  assert.equal((await late.create(ADMIN, USER, body())).weekStart, W);
});

test("create: 409 LOAN_EXISTS when she already has an active loan that week (also on a concurrent insert)", async () => {
  const taken = setup({ loans: [{ ...LOAN, id: "x1", cedula: "111111" }] });
  await assert.rejects(taken.service.create(ADMIN, USER, body()), code(409, "LOAN_EXISTS"));
  assert.equal(taken.repo.state.calls.length, 0);
  const race = setup({ throwOnCreate: new LoanExistsError() });
  await assert.rejects(race.service.create(ADMIN, USER, body()), code(409, "LOAN_EXISTS"));
  const gone = setup({ throwOnCreate: new LoanSedeMissingError() });
  await assert.rejects(gone.service.create(ADMIN, USER, body()), code(404, "SEDE_NOT_MAPPED"));
  // Another week of the same person is independent.
  const other = setup({ loans: [{ ...LOAN, id: "x1", weekStart: NEXT }] });
  assert.equal((await other.service.create(ADMIN, USER, body())).weekStart, W);
});

test("create: 409 LOAN_HAS_SHIFTS when she has shifts (any tipo) in her home sede that week; shifts elsewhere or other weeks do not block", async () => {
  const blocked = setup({ shifts: [{ cedula: "111111", sedeId: "s1", fecha: "2031-01-12" }] });
  await assert.rejects(blocked.service.create(ADMIN, USER, body()), (e) => code(409, "LOAN_HAS_SHIFTS")(e) && /sede esa semana/.test(e.message));
  assert.deepEqual(blocked.shiftCalls[0], { cedula: "111111", sedeId: "s1", from: W, to: "2031-01-12" });
  assert.equal(blocked.repo.state.calls.length, 0);
  const free = setup({ shifts: [{ cedula: "111111", sedeId: "s2", fecha: W }, { cedula: "111111", sedeId: "s1", fecha: "2031-01-13" }] });
  assert.equal((await free.service.create(ADMIN, USER, body())).id, lid(1));
});

test("create: shifts saved while the loan was being inserted -> the new loan is revoked by the actor and the answer is 409 LOAN_HAS_SHIFTS", async () => {
  const { service, repo } = setup({ shiftsAppearAfterCreate: true });
  await assert.rejects(service.create(ADMIN, USER, body()), code(409, "LOAN_HAS_SHIFTS"));
  assert.deepEqual(repo.state.calls.map((c) => c[0]), ["create", "revoke"]);
  assert.deepEqual(repo.state.calls[1][1], { id: lid(1), userId: USER.id });
  assert.equal(await repo.findActive("111111", W), null, "the week is free again");
});

test("cancel: a loan of a past week cannot be cancelled (400 LOAN_WEEK_PAST); the current week can", async () => {
  const past = setup({ loans: [{ ...LOAN, id: "x1", weekStart: PAST }] });
  await assert.rejects(past.service.cancel(ADMIN, USER, "x1"), (e) => code(400, "LOAN_WEEK_PAST")(e) && e.message === "No puedes cancelar el préstamo de una semana que ya pasó.");
  assert.equal(past.repo.state.calls.length, 0);
  const current = setup({ loans: [{ ...LOAN, id: "x1", weekStart: W }] });
  assert.equal((await current.service.cancel(ADMIN, USER, "x1")).id, "x1");
});

test("repo: while migration 016 is missing the reads answer [] (warning once); real errors fail closed; writes answer 503 LOANS_UNAVAILABLE", async () => {
  for (const missing of [{ code: "42P01" }, { code: "PGRST205" }]) {
    const warnings = [];
    const gone = () => ({ data: null, error: missing });
    const { client } = fakeClient({ results: [gone(), gone(), gone(), gone()] });
    const repo = createEmployeeLoansRepo(client, { logger: { warn: (m) => warnings.push(m) } });
    assert.deepEqual(await repo.listActiveByWeek(W), []);
    assert.deepEqual(await repo.listActiveLentOut({ sedeId: "s1", weekStart: W, cedulas: ["111111"] }), []);
    assert.deepEqual(await repo.listActiveByWeek(W), []);
    assert.equal(warnings.length, 1, "warned once");
    assert.match(warnings[0], /migration 016/);
    const writes = fakeClient({ results: [gone(), gone(), gone(), gone()] });
    const wrepo = createEmployeeLoansRepo(writes.client, { logger: null });
    const unavailable = (e) => e.statusCode === 503 && e.code === "LOANS_UNAVAILABLE" && e.expose === true;
    await assert.rejects(wrepo.create({ cedula: "111111", homeSedeId: "s1", hostSedeId: "s2", weekStart: W, userId: "u" }), unavailable);
    await assert.rejects(wrepo.revoke({ id: ID1, userId: "u" }), unavailable);
    await assert.rejects(wrepo.findActive("111111", W), unavailable);
    await assert.rejects(wrepo.findActiveById(ID1), unavailable);
  }
  const boom = { code: "XX000", message: "db down" };
  const real = createEmployeeLoansRepo(fakeClient({ results: [{ data: null, error: boom }, { data: null, error: boom }] }).client, { logger: null });
  await assert.rejects(real.listActiveByWeek(W), (e) => e === boom);
  await assert.rejects(real.listActiveLentOut({ sedeId: "s1", weekStart: W, cedulas: ["111111"] }), (e) => e === boom);
});

test("cancel: revokes the loan; the planner of the home sede (or admin) can, the host's alone cannot", async () => {
  const loans = [{ ...LOAN, id: "x1" }];
  const { service, repo } = setup({ loans });
  const out = await service.cancel(PLANNER_HOME, USER, "x1");
  assert.equal(out.id, "x1");
  assert.deepEqual(repo.state.calls[0], ["revoke", { id: "x1", userId: USER.id }]);
  const again = setup({ loans });
  await assert.rejects(again.service.cancel(PLANNER_HOST, USER, "x1"), code(403, "FORBIDDEN_SEDE"));
  await assert.rejects(again.service.cancel(VIEWER_HOST, USER, "x1"), code(403, "FORBIDDEN_ROLE"));
  assert.equal((await again.service.cancel(ADMIN, USER, "x1")).id, "x1");
});

test("cancel: 404 when unknown or already revoked", async () => {
  const { service } = setup({ loans: [{ ...LOAN, id: "x1", revokedAt: "t" }] });
  await assert.rejects(service.cancel(ADMIN, USER, "x1"), code(404, "LOAN_NOT_FOUND"));
  await assert.rejects(service.cancel(ADMIN, USER, "nope"), code(404, "LOAN_NOT_FOUND"));
});

test("cancel: 409 LOAN_HAS_SHIFTS when she already has shifts in the HOST sede that week", async () => {
  const { service, repo, shiftCalls } = setup({ loans: [{ ...LOAN, id: "x1" }], shifts: [{ cedula: "111111", sedeId: "s2", fecha: "2031-01-08" }] });
  await assert.rejects(service.cancel(ADMIN, USER, "x1"), (e) => code(409, "LOAN_HAS_SHIFTS")(e) && /sede que la recibió/.test(e.message));
  assert.deepEqual(shiftCalls[0], { cedula: "111111", sedeId: "s2", from: W, to: "2031-01-12" });
  assert.equal(repo.state.calls.length, 0);
});

test("list: admin sees every loan of the week, others only those whose home OR host sede they can access", async () => {
  const loans = [
    { ...LOAN, id: "a", cedula: "111111", homeSedeId: "s1", hostSedeId: "s2" },
    { ...LOAN, id: "b", cedula: "222222", homeSedeId: "s3", hostSedeId: "s1" },
    { ...LOAN, id: "c", cedula: "999999", homeSedeId: "s3", hostSedeId: "s3", weekStart: W },
    { ...LOAN, id: "d", cedula: "111111", weekStart: NEXT },
    { ...LOAN, id: "e", cedula: "111111", revokedAt: "t" },
  ];
  const { service } = setup({ loans });
  const ids = async (access) => (await service.list(access, { weekStart: W })).map((l) => l.id).sort();
  assert.deepEqual(await ids(ADMIN), ["a", "b", "c"]);
  assert.deepEqual(await ids(PLANNER_HOME), ["a", "b"], "home of a, host of b");
  assert.deepEqual(await ids(VIEWER_HOST), ["a"], "host of a");
  assert.deepEqual(await ids(VIEWER_OTHER), ["b", "c"]);
  const first = (await service.list(ADMIN, { weekStart: W })).find((l) => l.id === "a");
  assert.deepEqual(Object.keys(first).sort(), ["cargo", "cedula", "createdAt", "homeSedeId", "homeSedeNombre", "hostSedeId", "hostSedeNombre", "id", "motivo", "nombre", "weekStart"]);
  const unknown = (await service.list(ADMIN, { weekStart: W })).find((l) => l.id === "c");
  assert.equal(unknown.nombre, null);
  assert.equal(unknown.cargo, null);
});

// ---------------------------------------------------------------------------
// Directory lookup used by the service
// ---------------------------------------------------------------------------
test("empleadosService.findByCedula: active and pre-contractual rows, null when unknown, any spelling of the cedula", async () => {
  const service = createEmpleadosService({
    client: {
      fetchEmpleadosActivos: async () => ({ data: [{ cedula: "111111", nombre: "Ana", cargo: "Cajera", sede: "Centro", activo: true }], total: 1, actualizado: "2031-01-01T00:00:00.000Z" }),
      fetchPrecontractuales: async () => ({ data: [{ cedula: "444444", nombre: "Pre", cargo: "Cajera", sede: "Centro", precontractual: true }] }),
    },
    aliasRepo: { loadAliasMap: async () => new Map([["centro", "s1"]]) },
    logger: null,
  });
  assert.equal((await service.findByCedula("0111111")).nombre, "Ana");
  assert.equal(await service.findByCedula("555555"), null);
  const pre = await service.findByCedula("444444");
  assert.equal(pre?.cedula, "444444");
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const TOKENS = { "t-admin": "u-admin", "t-home": "u-home", "t-host": "u-host", "t-viewer": "u-viewer", "t-stranger": "u-none" };
const ACCESS = {
  "u-admin": { role: "admin", sede_ids: null },
  "u-home": { role: "planner", sede_ids: ["s1"] },
  "u-host": { role: "planner", sede_ids: ["s2"] },
  "u-viewer": { role: "viewer", sede_ids: ["s2"] },
};

async function start({ loans = [], shifts = [] } = {}) {
  const { service: loansService, repo } = setup({ loans, shifts });
  const service = createEmpleadosService({
    client: { fetchEmpleadosActivos: async () => ({ data: [], total: 0, actualizado: "2031-01-01T00:00:00.000Z" }) },
    aliasRepo: { loadAliasMap: async () => new Map() },
    logger: null,
  });
  const router = createEmpleadosRouter({
    authenticate: createAuthenticate({ verifyToken: async (t) => (TOKENS[t] ? { id: TOKENS[t], email: "x@x.co" } : null) }),
    accessRepo: { findByUserId: async (id) => ACCESS[id] ?? null },
    service,
    loansService,
  });
  const server = createApp({ routes: createRoutes({ modules: { "/empleados": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/empleados`;
  const call = async (method, path, token, json) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { call, repo, close: () => new Promise((r) => server.close(r)) };
}
async function withApp(opts, fn) {
  const app = await start(opts);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test("routes: 401 without token, 403 without an access row", () =>
  withApp({}, async ({ call }) => {
    assert.equal((await call("GET", `/prestamos?weekStart=${W}`, null)).status, 401);
    assert.equal((await call("GET", `/prestamos?weekStart=${W}`, "t-stranger")).status, 403);
  }));

test("routes: POST -> 201 { data }, GET lists it, DELETE revokes it (and a second DELETE is 404)", () =>
  withApp({}, async ({ call }) => {
    const created = await call("POST", "/prestamos", "t-home", { cedula: "111111", hostSedeId: "s2", weekStart: W, motivo: "Apoyo" });
    assert.equal(created.status, 201);
    assert.equal(created.json.data.homeSedeNombre, "Centro");
    assert.equal(created.json.data.hostSedeNombre, "Norte");
    const listed = await call("GET", `/prestamos?weekStart=${W}`, "t-viewer");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.data.map((l) => l.id), [created.json.data.id]);
    const removed = await call("DELETE", `/prestamos/${created.json.data.id}`, "t-admin");
    assert.equal(removed.status, 200);
    assert.equal(removed.json.data.id, created.json.data.id);
    assert.equal((await call("GET", `/prestamos?weekStart=${W}`, "t-admin")).json.data.length, 0);
  }));

test("routes: the host's planner cannot create or cancel (403), a viewer cannot write (403 FORBIDDEN_ROLE)", () =>
  withApp({ loans: [{ ...LOAN, id: "11111111-1111-4111-8111-111111111112" }] }, async ({ call }) => {
    const mine = { cedula: "111111", hostSedeId: "s2", weekStart: W };
    assert.equal((await call("POST", "/prestamos", "t-host", mine)).json.code, "FORBIDDEN_SEDE");
    assert.equal((await call("POST", "/prestamos", "t-viewer", mine)).json.code, "FORBIDDEN_ROLE");
    assert.equal((await call("DELETE", "/prestamos/11111111-1111-4111-8111-111111111112", "t-host")).json.code, "FORBIDDEN_SEDE");
    assert.equal((await call("DELETE", "/prestamos/11111111-1111-4111-8111-111111111112", "t-viewer")).json.code, "FORBIDDEN_ROLE");
  }));

test("routes: validation 400, LOAN_EXISTS and LOAN_HAS_SHIFTS 409, unknown id 404", () =>
  withApp({ shifts: [{ cedula: "111111", sedeId: "s1", fecha: "2031-01-14" }] }, async ({ call }) => {
    assert.equal((await call("GET", "/prestamos", "t-admin")).status, 400);
    assert.equal((await call("GET", "/prestamos?weekStart=2031-01-07", "t-admin")).status, 400);
    assert.equal((await call("POST", "/prestamos", "t-admin", { cedula: "1", hostSedeId: "s2", weekStart: W })).json.code, "VALIDATION_ERROR");
    assert.equal((await call("DELETE", "/prestamos/not-a-uuid", "t-admin")).json.code, "VALIDATION_ERROR");
    assert.equal((await call("DELETE", "/prestamos/11111111-1111-4111-8111-111111111119", "t-admin")).json.code, "LOAN_NOT_FOUND");
    const blocked = await call("POST", "/prestamos", "t-admin", { cedula: "111111", hostSedeId: "s2", weekStart: NEXT });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, "LOAN_HAS_SHIFTS");
    assert.equal((await call("POST", "/prestamos", "t-admin", { cedula: "111111", hostSedeId: "s2", weekStart: W })).status, 201);
    const dup = await call("POST", "/prestamos", "t-admin", { cedula: "111111", hostSedeId: "s3", weekStart: W });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.code, "LOAN_EXISTS");
  }));

test("routes: /:cedula routes keep working next to /prestamos", () =>
  withApp({}, async ({ call }) => {
    const res = await call("PUT", "/111111/exclusion-caja", "t-viewer", { excluido: true });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, "FORBIDDEN_ROLE");
  }));

// ---------------------------------------------------------------------------
// Migration (static)
// ---------------------------------------------------------------------------
const read = (rel) => readFileSync(new URL(`../../db/${rel}`, import.meta.url), "utf8");
const flat = (s) => s.toLowerCase().replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

test("migration 016: table, checks, partial indexes, RLS closed to anon/authenticated", () => {
  const sql = flat(read("migrations/016_employee_loans.sql"));
  assert.ok(sql.includes("create table if not exists employee_loans"));
  assert.ok(sql.includes("id uuid primary key default gen_random_uuid()"));
  assert.ok(sql.includes("cedula text not null check (cedula ~ '^[0-9]{5,15}$')"));
  assert.ok(sql.includes("home_sede_id text not null references sugerido_sedes (sede_id)"));
  assert.ok(sql.includes("host_sede_id text not null references sugerido_sedes (sede_id)"));
  assert.ok(sql.includes("week_start date not null check (extract(isodow from week_start) = 1)"));
  assert.ok(sql.includes("char_length(motivo) <= 200"));
  assert.ok(sql.includes("check (home_sede_id <> host_sede_id)"));
  assert.ok(sql.includes("check ((revoked_at is null) = (revoked_by is null))"));
  assert.ok(sql.includes("create unique index if not exists employee_loans_active_cedula_week_idx on employee_loans (cedula, week_start) where revoked_at is null"));
  assert.ok(sql.includes("create index if not exists employee_loans_active_week_idx on employee_loans (week_start) where revoked_at is null"));
  assert.ok(sql.includes("alter table employee_loans enable row level security"));
  assert.ok(sql.includes("revoke all on table employee_loans from anon, authenticated"));
  assert.doesNotMatch(sql, /create policy/);
  assert.match(read("migrations/016_employee_loans.sql"), /apply this BEFORE deploying the backend/i);
});

test("migration 016: rollback snapshots then drops; verify ends in ROLLBACK", () => {
  const d = flat(read("migrations/rollback/016_employee_loans.down.sql"));
  assert.ok(d.indexOf("create table employee_loans_backup_016") < d.indexOf("execute 'drop table employee_loans'"));
  assert.ok(d.indexOf("raise exception 'employee_loans_backup_016 already exists") < d.indexOf("create table employee_loans_backup_016"), "stops before touching anything");
  assert.equal((d.match(/drop table/g) ?? []).length, 1);
  assert.ok(d.trim().endsWith("end $$;"), "everything is inside the one DO block");
  const v = flat(read("verification/016_employee_loans_verify.sql")).trim();
  assert.match(v, /^begin;/);
  assert.match(v, /rollback;$/);
  assert.ok(v.includes("all checks passed"));
});
