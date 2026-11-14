import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { diffSnapshotRows } = await import("../../src/modules/horarios/domain/snapshotDiff.js");
const { createHorariosService } = await import("../../src/modules/horarios/horarios.service.js");
const { createPublishSnapshotsRepo } = await import("../../src/modules/horarios/publishSnapshots.supabase.js");
const { snapshotParamsSchema, snapshotsListQuerySchema } = await import("../../src/modules/horarios/horarios.schemas.js");

const U = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const PLANNER = U("2");
const code = (status, c) => (e) => e.statusCode === status && e.code === c && e.expose === true;

const work = (cedula, fecha, startTime, endTime, lunchStart = null) => ({ cedula, fecha, tipo: "TRABAJO", startTime, endTime, breakMinutes: 60, lunchStart });
const rest = (cedula, fecha, tipo = "DESCANSO") => ({ cedula, fecha, tipo, startTime: null, endTime: null, breakMinutes: 0, lunchStart: null });

// ------------------------------------------------------------------ diff

test("diffSnapshotRows compares day by day: same, changed (hours or rest kind), added and removed; lunch alone is not a change", () => {
  const suggested = [work("1", "2031-01-06", "07:00", "15:00", "11:00"), work("1", "2031-01-07", "07:00", "15:00"), rest("1", "2031-01-08"), work("2", "2031-01-06", "12:00", "20:00")];
  const published = [work("1", "2031-01-06", "07:00", "15:00", "12:00"), work("1", "2031-01-07", "08:00", "16:00"), rest("1", "2031-01-08", "COMPENSATORIO"), work("3", "2031-01-06", "09:00", "17:00")];
  assert.deepEqual(diffSnapshotRows(suggested, published), { days: 5, same: 1, changed: 2, added: 1, removed: 1, people: 3, peopleChanged: 3 });
});

test("diffSnapshotRows: identical schedules have no change; null suggestion gives null", () => {
  const rows = [work("1", "2031-01-06", "07:00", "15:00"), rest("1", "2031-01-07")];
  assert.deepEqual(diffSnapshotRows(rows, rows.map((r) => ({ ...r }))), { days: 2, same: 2, changed: 0, added: 0, removed: 0, people: 1, peopleChanged: 0 });
  assert.equal(diffSnapshotRows(null, rows), null);
});

// ------------------------------------------------------------------ service

const SNAP = (over = {}) => ({
  id: U("c"),
  sedeId: "copacabana",
  weekStart: "2031-01-06",
  scheduleVersion: 3,
  publishedBy: PLANNER,
  publishedAt: "2031-01-02T15:00:00.000Z",
  recommendation: { runVersion: 4, dataAsOf: "2030-12-30", registers: 10, slots: [] },
  suggested: { shifts: [work("1", "2031-01-06", "07:00", "15:00")] },
  published: [work("1", "2031-01-06", "08:00", "16:00")],
  ...over,
});

function setup({ snapshots = [SNAP()], sedes = ["copacabana", "las-vegas"] } = {}) {
  const calls = [];
  const repo = { async findSede(id) { return sedes.includes(id) ? { sede_id: id } : null; } };
  const snapshotsRepo = {
    async listBySede(args) { calls.push(["listBySede", args]); return snapshots.filter((s) => s.sedeId === args.sedeId); },
    async findById(id) { calls.push(["findById", id]); return snapshots.find((s) => s.id === id) ?? null; },
  };
  const profilesRepo = { async findById(id) { return id === PLANNER ? { nombre: "Paula Planner" } : null; } };
  return { calls, service: createHorariosService({ repo, profilesRepo, snapshotsRepo }) };
}
const admin = { role: "admin", sedeIds: null };

test("listSnapshots: newest first as the repo gives them, with who published and the change summary, without the heavy payload", async () => {
  const { service, calls } = setup();
  const out = await service.listSnapshots(admin, "copacabana", { limit: 10 });
  assert.deepEqual(calls[0], ["listBySede", { sedeId: "copacabana", limit: 10 }]);
  assert.deepEqual(out, [
    {
      id: U("c"),
      weekStart: "2031-01-06",
      scheduleVersion: 3,
      publishedAt: "2031-01-02T15:00:00.000Z",
      publishedBy: "Paula Planner",
      hasRecommendation: true,
      hasSuggestion: true,
      diff: { days: 1, same: 0, changed: 1, added: 0, removed: 0, people: 1, peopleChanged: 1 },
    },
  ]);
});

test("listSnapshots: a snapshot without suggestion has diff null; an unknown sede is 404", async () => {
  const { service } = setup({ snapshots: [SNAP({ suggested: null, recommendation: null })] });
  const [item] = await service.listSnapshots(admin, "copacabana", { limit: 10 });
  assert.deepEqual([item.hasRecommendation, item.hasSuggestion, item.diff], [false, false, null]);
  await assert.rejects(service.listSnapshots(admin, "nope", { limit: 10 }), code(404, "SEDE_NOT_FOUND"));
});

test("getSnapshot: the full three parts; another sede's id or an unknown id is 404 SNAPSHOT_NOT_FOUND", async () => {
  const { service } = setup();
  const out = await service.getSnapshot(admin, "copacabana", U("c"));
  assert.equal(out.publishedBy, "Paula Planner");
  assert.deepEqual(Object.keys(out).sort(), ["diff", "id", "published", "publishedAt", "publishedBy", "recommendation", "scheduleVersion", "suggested", "weekStart"]);
  await assert.rejects(service.getSnapshot(admin, "las-vegas", U("c")), code(404, "SNAPSHOT_NOT_FOUND"));
  await assert.rejects(service.getSnapshot(admin, "copacabana", U("d")), code(404, "SNAPSHOT_NOT_FOUND"));
});

test("listSnapshots / getSnapshot need access to the sede", async () => {
  const { service } = setup();
  const other = { role: "planner", sedeIds: ["las-vegas"] };
  await assert.rejects(service.listSnapshots(other, "copacabana", { limit: 10 }), code(403, "FORBIDDEN_SEDE"));
  await assert.rejects(service.getSnapshot(other, "copacabana", U("c")), code(403, "FORBIDDEN_SEDE"));
});

// ------------------------------------------------------------------ repo

function fakeClient(results) {
  const log = [];
  const builder = (result) =>
    new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve(result).then(res, rej);
        return (...args) => (log.push([prop, ...args]), builder(result));
      },
    });
  const queue = results.slice();
  return { log, client: { from: (t) => (log.push(["from", t]), builder(queue.shift() ?? { data: null, error: null })) } };
}
const ROW = {
  id: U("c"), sede_id: "copacabana", week_start: "2031-01-06", schedule_version: 3, published_by: PLANNER,
  published_at: "2031-01-02T15:00:00+00:00", recommendation: null, suggested: null, published: [],
};

test("repo.listBySede: newest first for one sede, limited, mapped to camelCase", async () => {
  const { client, log } = fakeClient([{ data: [ROW], error: null }]);
  const [item] = await createPublishSnapshotsRepo(client).listBySede({ sedeId: "copacabana", limit: 5 });
  assert.deepEqual([item.id, item.weekStart, item.scheduleVersion, item.publishedAt, item.published], [U("c"), "2031-01-06", 3, "2031-01-02T15:00:00.000Z", []]);
  assert.ok(log.some((c) => JSON.stringify(c) === JSON.stringify(["eq", "sede_id", "copacabana"])));
  assert.ok(log.some((c) => JSON.stringify(c) === JSON.stringify(["order", "published_at", { ascending: false }])));
  assert.ok(log.some((c) => JSON.stringify(c) === JSON.stringify(["limit", 5])));
});

test("repo.findById: the row or null", async () => {
  assert.equal((await createPublishSnapshotsRepo(fakeClient([{ data: ROW, error: null }]).client).findById(U("c"))).sedeId, "copacabana");
  assert.equal(await createPublishSnapshotsRepo(fakeClient([{ data: null, error: null }]).client).findById(U("c")), null);
});

// ------------------------------------------------------------------ schemas

test("schemas: snapshot id is a uuid; limit 1..52, default 26", () => {
  assert.equal(snapshotParamsSchema.safeParse({ sedeId: "copacabana", snapshotId: U("c") }).success, true);
  assert.equal(snapshotParamsSchema.safeParse({ sedeId: "copacabana", snapshotId: "x" }).success, false);
  assert.equal(snapshotsListQuerySchema.parse({}).limit, 26);
  assert.equal(snapshotsListQuerySchema.parse({ limit: "5" }).limit, 5);
  assert.equal(snapshotsListQuerySchema.safeParse({ limit: "0" }).success, false);
});
