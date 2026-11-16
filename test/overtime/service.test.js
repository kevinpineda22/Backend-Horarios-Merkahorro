import test from "node:test";
import assert from "node:assert/strict";

const { createOvertimeService, parseApprovers } = await import("../../src/modules/overtime/overtime.service.js");

const U = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const PLANNER = { id: U("2"), email: "lider@merkahorrosas.com" };
const ANNY = { id: U("5"), email: "analista@merkahorrosas.com" };
const RAMIRO = { id: U("6"), email: "OPERACIONES@merkahorrosas.com" };
const OTHER = { id: U("7"), email: "otro@merkahorrosas.com" };
const APPROVERS = ["analista@merkahorrosas.com", "operaciones@merkahorrosas.com"];
const WEEK = "2026-11-23";
const planner = { role: "planner", sedeIds: ["copacabana"] };
const viewer = { role: "viewer", sedeIds: ["copacabana"] };
const code = (status, c) => (e) => e.statusCode === status && e.code === c && e.expose === true;

function setup({ rows = [], mailFails = false } = {}) {
  const state = { rows: [...rows], mails: [] };
  let n = 0;
  const repo = {
    async findSede(id) { return id === "copacabana" ? { sedeId: id, nombre: "Principal Copacabana" } : null; },
    async findPending(sedeId, weekStart) { return state.rows.find((r) => r.sedeId === sedeId && r.weekStart === weekStart && r.status === "PENDIENTE") ?? null; },
    async create(args) {
      const row = { id: `r${(n += 1)}`, ...args, status: "PENDIENTE", requestedAt: "2026-11-16T15:00:00.000Z", decidedBy: null, decidedAt: null, decisionComment: null };
      state.rows.push(row);
      return row;
    },
    async listByWeek(sedeId, weekStart) { return state.rows.filter((r) => r.sedeId === sedeId && r.weekStart === weekStart); },
    async listByStatus({ status }) { return state.rows.filter((r) => !status || r.status === status); },
    async findById(id) { return state.rows.find((r) => r.id === id) ?? null; },
    async decide({ id, status, decidedBy, comment }) {
      const row = state.rows.find((r) => r.id === id && r.status === "PENDIENTE");
      if (!row) return null;
      Object.assign(row, { status, decidedBy, decidedAt: "2026-11-16T16:00:00.000Z", decisionComment: comment });
      return row;
    },
  };
  const profilesRepo = {
    async findById(id) {
      return { [PLANNER.id]: { nombre: "Laura Líder", correo: "lider@merkahorrosas.com" }, [ANNY.id]: { nombre: "Anny", correo: ANNY.email } }[id] ?? null;
    },
  };
  const mailer = {
    async send(message) {
      state.mails.push(message);
      if (mailFails) throw new Error("smtp down");
      return { sent: true };
    },
  };
  const service = createOvertimeService({ repo, profilesRepo, mailer, approvers: APPROVERS, appUrl: "https://merkahorro.com", logger: null });
  return { service, state };
}

// ---------------------------------------------------------------- approvers

test("parseApprovers: comma list, trimmed, lowercase, deduplicated; default when empty", () => {
  assert.deepEqual(parseApprovers(" A@x.co, b@x.co ,a@X.co"), ["a@x.co", "b@x.co"]);
  assert.deepEqual(parseApprovers(""), APPROVERS);
});

test("me: whether the caller approves (by e-mail, any case)", async () => {
  const { service } = setup();
  assert.deepEqual(await service.me(RAMIRO), { isApprover: true });
  assert.deepEqual(await service.me(OTHER), { isApprover: false });
});

// ---------------------------------------------------------------- request

test("request: a leader asks for hours with a reason; both approvers get one e-mail with a link to Autorizaciones", async () => {
  const { service, state } = setup();
  const out = await service.request(planner, PLANNER, "copacabana", WEEK, { hours: 6.5, motivo: "Temporada navideña" });
  assert.equal(out.emailSent, true);
  assert.deepEqual(
    { sedeId: out.request.sedeId, weekStart: out.request.weekStart, hours: out.request.hours, motivo: out.request.motivo, status: out.request.status, requestedBy: out.request.requestedBy },
    { sedeId: "copacabana", weekStart: WEEK, hours: 6.5, motivo: "Temporada navideña", status: "PENDIENTE", requestedBy: "Laura Líder" },
  );
  assert.equal(state.mails.length, 1);
  assert.deepEqual(state.mails[0].to, APPROVERS);
  assert.match(state.mails[0].subject, /6,5 h extra/);
  assert.match(state.mails[0].html, /Principal Copacabana/);
  assert.match(state.mails[0].html, /Temporada navideña/);
  assert.match(state.mails[0].html, /https:\/\/merkahorro\.com\/horarios-merkahorro\?vista=autorizaciones/);
});

test("request: the request is saved even when the e-mail fails (emailSent false)", async () => {
  const { service, state } = setup({ mailFails: true });
  const out = await service.request(planner, PLANNER, "copacabana", WEEK, { hours: 4, motivo: "x" });
  assert.equal(out.emailSent, false);
  assert.equal(state.rows.length, 1);
});

test("request: one pending request per sede and week; viewers and other sedes cannot ask; unknown sede is 404", async () => {
  const { service } = setup();
  await service.request(planner, PLANNER, "copacabana", WEEK, { hours: 4, motivo: "x" });
  await assert.rejects(service.request(planner, PLANNER, "copacabana", WEEK, { hours: 2, motivo: "y" }), code(409, "OVERTIME_REQUEST_PENDING"));
  await assert.rejects(service.request(viewer, PLANNER, "copacabana", WEEK, { hours: 2, motivo: "y" }), code(403, "FORBIDDEN_ROLE"));
  await assert.rejects(service.request({ role: "planner", sedeIds: ["las-vegas"] }, PLANNER, "copacabana", WEEK, { hours: 2, motivo: "y" }), code(403, "FORBIDDEN_SEDE"));
  await assert.rejects(service.request({ role: "admin", sedeIds: null }, PLANNER, "nope", WEEK, { hours: 2, motivo: "y" }), code(404, "SEDE_NOT_FOUND"));
});

test("forWeek: the requests of a week, newest first, and the approved hours added up", async () => {
  const rows = [
    { id: "a", sedeId: "copacabana", weekStart: WEEK, hours: 4, motivo: "m", status: "APROBADA", requestedBy: PLANNER.id, requestedAt: "2026-11-15T10:00:00.000Z", decidedBy: ANNY.id, decidedAt: "2026-11-15T11:00:00.000Z", decisionComment: null },
    { id: "b", sedeId: "copacabana", weekStart: WEEK, hours: 3, motivo: "m", status: "RECHAZADA", requestedBy: PLANNER.id, requestedAt: "2026-11-16T10:00:00.000Z", decidedBy: ANNY.id, decidedAt: "2026-11-16T11:00:00.000Z", decisionComment: "No hay presupuesto" },
  ];
  const { service } = setup({ rows });
  const out = await service.forWeek(viewer, "copacabana", WEEK);
  assert.equal(out.approvedHours, 4);
  assert.deepEqual(out.items.map((i) => [i.id, i.status, i.decidedBy]), [["b", "RECHAZADA", "Anny"], ["a", "APROBADA", "Anny"]]);
  assert.equal(out.items[0].decisionComment, "No hay presupuesto");
});

// ---------------------------------------------------------------- decide

test("decide: any one approver approves or rejects a pending request; the leader gets an e-mail", async () => {
  const { service, state } = setup();
  const { request } = await service.request(planner, PLANNER, "copacabana", WEEK, { hours: 5, motivo: "x" });
  const out = await service.decide(RAMIRO, request.id, { decision: "APROBADA", comment: "Ok, solo esta semana" });
  assert.equal(out.request.status, "APROBADA");
  assert.equal(out.request.decisionComment, "Ok, solo esta semana");
  const toLeader = state.mails.at(-1);
  assert.deepEqual(toLeader.to, ["lider@merkahorrosas.com"]);
  assert.match(toLeader.subject, /aprobada/i);
  await assert.rejects(service.decide(ANNY, request.id, { decision: "RECHAZADA", comment: null }), code(409, "OVERTIME_ALREADY_DECIDED"));
});

test("decide: only approvers; an unknown id is 404", async () => {
  const { service } = setup();
  const { request } = await service.request(planner, PLANNER, "copacabana", WEEK, { hours: 5, motivo: "x" });
  await assert.rejects(service.decide(OTHER, request.id, { decision: "APROBADA" }), code(403, "NOT_AN_APPROVER"));
  await assert.rejects(service.decide(ANNY, "nope", { decision: "APROBADA" }), code(404, "OVERTIME_REQUEST_NOT_FOUND"));
});

test("listForApprovers: approvers only, filtered by status, with the requester's name", async () => {
  const { service } = setup();
  await service.request(planner, PLANNER, "copacabana", WEEK, { hours: 5, motivo: "x" });
  const items = await service.listForApprovers(ANNY, { status: "PENDIENTE" });
  assert.deepEqual(items.map((i) => [i.sedeId, i.sedeNombre, i.hours, i.requestedBy]), [["copacabana", "Principal Copacabana", 5, "Laura Líder"]]);
  await assert.rejects(service.listForApprovers(OTHER, { status: "PENDIENTE" }), code(403, "NOT_AN_APPROVER"));
});
