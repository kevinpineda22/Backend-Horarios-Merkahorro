import test from "node:test";
import assert from "node:assert/strict";

import { createAccuracyService } from "../../src/modules/sugerido/accuracy.service.js";
import { SETTINGS, fakeSuggestions } from "./api.helpers.js";

const WEEK = "2026-11-02"; // Monday; Sunday is 2026-11-08
const CLOSED_NOW = new Date("2026-11-12T15:00:00Z");
const SLOTS = ["08:00", "08:15", "08:30", "08:45"];

// 40 docs/cashier-hour * utilization 0.85 = 34 docs/h per cashier; 20 docs per 15 min = 80 docs/h -> ceil(80/34) = 3
const PRODUCTIVITY = 40;
const day = (docs) => Object.fromEntries(SLOTS.map((f) => [f, { docs, venta: 0 }]));
const weekSales = (docs = 20) =>
  Object.fromEntries(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"].map((d) => [d, day(docs)]));

function setup({ snapshot, run = "default", sales = { dataAsOf: "2026-11-08", slots: weekSales(), daily: {}, productivityRows: [] }, past = null, after = null, snapshots = null, minCashiers = null, now = CLOSED_NOW } = {}) {
  const calls = { sales: [] };
  const defaultRun = {
    id: "r1", version: 4, settings: { ...SETTINGS, ...(minCashiers === null ? {} : { minCashiers }) }, inputs: { productivity: PRODUCTIVITY },
    slots: SLOTS.map((franja) => ({ fecha: "2026-11-02", franja, forecastDocs: 16, required: 2, available: 2, suggested: 2 })),
  };
  const suggestionsRepo = {
    ...fakeSuggestions(),
    async getRunByVersion(sedeId, weekStart, version) { calls.run = [sedeId, weekStart, version]; return run === "default" ? defaultRun : run; },
  };
  const snap = snapshot === undefined
    ? { id: "sn1", publishedAt: "2026-11-01T10:00:00.000Z", recommendation: { runVersion: 4, dataAsOf: "2026-10-31", registers: 10, slots: SLOTS.map((franja) => ({ fecha: "2026-11-02", franja, final: 4 })) } }
    : snapshot;
  const service = createAccuracyService({
    suggestionsRepo,
    settingsRepo: { async getSettings() { return { ...SETTINGS }; } },
    salesRepo: { async loadSlotHistory(args) { calls.sales.push(args); if (args.desde === "2026-11-09") return after ?? { dataAsOf: null, slots: {}, daily: {}, productivityRows: [] }; return args.hasta === "2026-10-31" && past ? past : sales; } },
    snapshotsRepo: { async findLatestByWeek(args) { calls.snap = args; return snapshots ? [...snapshots].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))[0] : snap; } },
    now: () => now,
  });
  return { service, calls };
}

test("OK: needed from real docs, system from the run, published from the snapshot", async () => {
  const { service, calls } = setup();
  const r = await service.getAccuracy("s1", WEEK);
  assert.equal(r.status, "OK");
  assert.equal(r.weekEnd, "2026-11-08");
  assert.equal(r.dataAsOf, "2026-11-08");
  assert.equal(r.systemAvailable, true);
  assert.equal(r.productivitySource, "run");
  assert.deepEqual(r.snapshot, { id: "sn1", publishedAt: "2026-11-01T10:00:00.000Z", runVersion: 4 });
  assert.deepEqual(calls.run, ["s1", WEEK, 4]);
  assert.deepEqual(calls.snap, { sedeId: "s1", weekStart: WEEK, teamKey: "CAJEROS" }); // accuracy reads the cashier team only
  assert.equal(calls.sales[0].desde, WEEK);
  assert.equal(calls.sales[0].hasta, "2026-11-08");
  assert.equal(r.summary.docs.actual, 20 * 4 * 7);
  assert.equal(r.days.length, 7);
  // Monday 08:00-09:00: needed 3, system 2, published 4
  assert.deepEqual(r.days[0].hours, [{ hour: 8, needed: 3, system: 2, published: 4 }]);
  // The other days have no suggestion nor publication: needed 3, system 0, published 0
  assert.deepEqual(r.days[1].hours, [{ hour: 8, needed: 3, system: 0, published: 0 }]);
  assert.equal(r.days[0].system.underHours, 1); // 4 slots * 1 cashier * 0.25 h
  assert.equal(r.days[0].published.overHours, 1);
});

test("needed is capped by the registers of the snapshot", async () => {
  const snapshot = { id: "sn1", publishedAt: null, recommendation: { runVersion: 4, dataAsOf: "2026-10-31", registers: 2, slots: [{ fecha: "2026-11-02", franja: "08:00", final: 2 }] } };
  const r = await setup({ snapshot }).service.getAccuracy("s1", WEEK);
  assert.equal(r.days[0].hours[0].needed, 2);
});

test("NOT_CLOSED: the week is current or future, no source is touched", async () => {
  const { service, calls } = setup({ now: new Date("2026-11-08T15:00:00Z") });
  const r = await service.getAccuracy("s1", WEEK);
  assert.equal(r.status, "NOT_CLOSED");
  assert.equal(r.summary, null);
  assert.deepEqual(r.days, []);
  assert.equal(calls.sales.length, 0);
  assert.equal(calls.snap, undefined);
});

test("NO_SNAPSHOT: never published, or published without recommendation", async () => {
  assert.equal((await setup({ snapshot: null }).service.getAccuracy("s1", WEEK)).status, "NO_SNAPSHOT");
  assert.equal((await setup({ snapshot: { id: "x", recommendation: null } }).service.getAccuracy("s1", WEEK)).status, "NO_SNAPSHOT");
  assert.equal((await setup({ snapshot: { id: "x", recommendation: { slots: [] } } }).service.getAccuracy("s1", WEEK)).status, "NO_SNAPSHOT");
});

test("INCOMPLETE: sales stop before Sunday, answers with dataAsOf and no metrics", async () => {
  const { service } = setup({ sales: { dataAsOf: "2026-11-06", slots: weekSales(), daily: {}, productivityRows: [] } });
  const r = await service.getAccuracy("s1", WEEK);
  assert.equal(r.status, "INCOMPLETE");
  assert.equal(r.dataAsOf, "2026-11-06");
  assert.equal(r.summary, null);
  assert.equal(r.snapshot.id, "sn1");
  const none = await setup({ sales: { dataAsOf: null, slots: {}, daily: {}, productivityRows: [] } }).service.getAccuracy("s1", WEEK);
  assert.deepEqual([none.status, none.dataAsOf], ["INCOMPLETE", null]);
});

test("run missing: systemAvailable false, productivity rebuilt from sales, docs metrics dropped", async () => {
  const past = { dataAsOf: "2026-10-31", slots: {}, daily: {}, productivityRows: [{ fecha: "2026-10-30", franja: "08:00", docs: 20, cajeras: 2 }] };
  const { service, calls } = setup({ run: null, past });
  const r = await service.getAccuracy("s1", WEEK);
  assert.equal(r.status, "OK");
  assert.equal(r.systemAvailable, false);
  assert.equal(r.productivitySource, "reconstructed");
  assert.equal(r.summary.system, null);
  assert.equal(r.summary.docs, null);
  assert.ok(r.summary.published);
  assert.equal(r.days[0].hours[0].system, null);
  assert.equal(calls.sales.at(-1).hasta, "2026-10-31");
});

test("PRODUCTIVITY_UNAVAILABLE: frozen productivity missing in the run, or nothing to rebuild it from", async () => {
  const noProd = { id: "r1", version: 4, settings: { ...SETTINGS }, inputs: { productivity: null }, slots: [] };
  await assert.rejects(setup({ run: noProd }).service.getAccuracy("s1", WEEK), (e) => e.statusCode === 409 && e.code === "PRODUCTIVITY_UNAVAILABLE");
  const past = { dataAsOf: null, slots: {}, daily: {}, productivityRows: [] };
  await assert.rejects(setup({ run: null, past }).service.getAccuracy("s1", WEEK), (e) => e.code === "PRODUCTIVITY_UNAVAILABLE");
});

test("unmapped sede is 404 before any source", async () => {
  const { service, calls } = setup();
  await assert.rejects(service.getAccuracy("nope", WEEK), (e) => e.statusCode === 404 && e.code === "SEDE_NOT_MAPPED");
  assert.equal(calls.sales.length, 0);
});

test("system is the run's required, not suggested: a short pool with a perfect forecast scores 0 over and 0 under", async () => {
  const run = {
    id: "r1", version: 4, settings: { ...SETTINGS }, inputs: { productivity: PRODUCTIVITY },
    slots: SLOTS.map((franja) => ({ fecha: "2026-11-02", franja, forecastDocs: 20, required: 3, available: 1, suggested: 1 })),
  };
  const r = await setup({ run }).service.getAccuracy("s1", WEEK);
  assert.equal(r.days[0].system.overHours, 0);
  assert.equal(r.days[0].system.underHours, 0);
  assert.equal(r.days[0].hours[0].system, 3);
});

test("system required is capped by the snapshot registers; a null required is missing, not 0", async () => {
  const run = {
    id: "r1", version: 4, settings: { ...SETTINGS }, inputs: { productivity: PRODUCTIVITY },
    slots: [
      { fecha: "2026-11-02", franja: "08:00", forecastDocs: 20, required: 5, available: 5, suggested: 5 },
      { fecha: "2026-11-02", franja: "08:15", forecastDocs: 20, required: null, available: 5, suggested: null },
    ],
  };
  const snapshot = { id: "sn1", publishedAt: null, recommendation: { runVersion: 4, dataAsOf: "2026-10-31", registers: 2, slots: [{ fecha: "2026-11-02", franja: "08:00", final: 2 }] } };
  const r = await setup({ run, snapshot }).service.getAccuracy("s1", WEEK);
  // Monday: slot 08:00 system min(5, 2) = 2 vs needed 2 -> exact; 08:15 is missing; 08:30/08:45 are not in the run -> 0
  assert.equal(r.days[0].system.missingSlots, 1);
  assert.equal(r.days[0].system.overHours, 0);
  assert.equal(r.days[0].system.underHours, 1); // 08:30 and 08:45: needed 2 (capped), system 0
});

test("INCOMPLETE is lifted when Sunday has no sales but later days do", async () => {
  const sales = { dataAsOf: "2026-11-07", slots: weekSales(), daily: {}, productivityRows: [] };
  const r = await setup({ sales, after: { dataAsOf: "2026-11-10", slots: {}, daily: {}, productivityRows: [] } }).service.getAccuracy("s1", WEEK);
  assert.equal(r.status, "OK");
  assert.equal(r.dataAsOf, "2026-11-10");
});

test("INCOMPLETE stays when there are no sales after the week either", async () => {
  const sales = { dataAsOf: "2026-11-07", slots: weekSales(), daily: {}, productivityRows: [] };
  const r = await setup({ sales, after: { dataAsOf: "2026-11-08", slots: {}, daily: {}, productivityRows: [] } }).service.getAccuracy("s1", WEEK);
  assert.equal(r.status, "INCOMPLETE");
  assert.equal(r.dataAsOf, "2026-11-07");
});

test("Bogota boundary: Sunday 23:00 Bogota is NOT_CLOSED, Monday 00:30 Bogota is closed", async () => {
  assert.equal((await setup({ now: new Date("2026-11-09T04:00:00Z") }).service.getAccuracy("s1", WEEK)).status, "NOT_CLOSED");
  assert.equal((await setup({ now: new Date("2026-11-09T05:30:00Z") }).service.getAccuracy("s1", WEEK)).status, "OK");
});

test("with several snapshots for the week the latest publication is used", async () => {
  const mk = (id, publishedAt, final) => ({ id, publishedAt, recommendation: { runVersion: 4, dataAsOf: "2026-10-31", registers: 10, slots: [{ fecha: "2026-11-02", franja: "08:00", final }] } });
  const snapshots = [mk("old", "2026-10-30T10:00:00.000Z", 1), mk("new", "2026-11-01T10:00:00.000Z", 4), mk("mid", "2026-10-31T10:00:00.000Z", 2)];
  const r = await setup({ snapshots }).service.getAccuracy("s1", WEEK);
  assert.equal(r.snapshot.id, "new");
  assert.equal(r.days[0].hours[0].published, 1); // 4 in one slot of the hour, 0 in the other three
});

test("needed is 0 where there are no docs even with minCashiers 1; docs-less slots do not inflate it", async () => {
  const sales = { dataAsOf: "2026-11-08", slots: { ...weekSales(), "2026-11-02": { "08:00": { docs: 20, venta: 0 }, "08:15": { docs: 0, venta: 0 } } }, daily: {}, productivityRows: [] };
  const r = await setup({ sales, minCashiers: 1 }).service.getAccuracy("s1", WEEK);
  const monday = r.days[0].hours[0];
  assert.equal(monday.needed, 0.75); // 08:00 -> 3 (smoothed over the open slot only), 08:15 closed -> 0, 08:30/08:45 not in sales -> 0
});

test("registers 0 or null do not cap the needed cashiers", async () => {
  for (const registers of [0, null]) {
    const snapshot = { id: "sn1", publishedAt: null, recommendation: { runVersion: 4, dataAsOf: "2026-10-31", registers, slots: [{ fecha: "2026-11-02", franja: "08:00", final: 2 }] } };
    const r = await setup({ snapshot }).service.getAccuracy("s1", WEEK);
    assert.equal(r.days[1].hours[0].needed, 3, `registers ${registers}`);
  }
});
