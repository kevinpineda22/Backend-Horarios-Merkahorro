import test from "node:test";
import assert from "node:assert/strict";

import { createSugeridoService } from "../../src/modules/sugerido/sugerido.service.js";
import { createHttpError } from "../../src/shared/http/HttpError.js";
import { ABSENCE_TYPES } from "../../src/modules/sugerido/domain/absences.js";
import { addDays } from "../../src/modules/sugerido/domain/dates.js";
import { HOLIDAY_LOOKBACK_DAYS, RECENT_LOOKBACK_DAYS } from "../../src/modules/sugerido/domain/calendar.js";
import { TREND_WINDOW_DAYS, YEAR_OFFSET_DAYS } from "../../src/modules/sugerido/domain/forecast.js";
import { PRODUCTIVITY_WINDOW_DAYS } from "../../src/modules/sugerido/domain/productivity.js";
import { POOL, SETTINGS, SLOTS_PER_OPEN_DAY, USER, WEEK, buildHistory, makeDeps } from "./api.helpers.js";

const setup = (opts) => {
  const ctx = makeDeps(opts);
  return { ...ctx, service: createSugeridoService(ctx.deps) };
};
const slotOf = (view, fecha, franja) => view.days.find((d) => d.fecha === fecha).slots.find((s) => s.franja === franja);
// The service derives its sales window from the look-backs owned by the domain modules.
const LOOKBACK = Math.max(HOLIDAY_LOOKBACK_DAYS, RECENT_LOOKBACK_DAYS, YEAR_OFFSET_DAYS + TREND_WINDOW_DAYS, PRODUCTIVITY_WINDOW_DAYS);
const rejectsWith = (p, status, code) => assert.rejects(p, (e) => e.statusCode === status && e.code === code);

test("computeRun wires every source with the sede, window and settings, and saves the run with a snapshot", async () => {
  const { service, calls, repo } = setup();
  const view = await service.computeRun(USER, "s1", WEEK);

  assert.deepEqual(calls.sales, [{ bodegas: ["B1", "B2"], desde: addDays(WEEK, -LOOKBACK), hasta: addDays(WEEK, 6) }]);
  assert.deepEqual(calls.staff, ["s1"]);
  assert.deepEqual(calls.absences, [{ weekStart: WEEK, blockingTypes: ABSENCE_TYPES }]);

  const saved = repo.calls.saveRun[0];
  assert.equal(saved.sedeId, "s1");
  assert.equal(saved.weekStart, WEEK);
  assert.equal(saved.createdBy, "u-planner");
  assert.equal(saved.dataAsOf, "2026-11-20");
  assert.equal(saved.slots.length, 7 * SLOTS_PER_OPEN_DAY);
  const { updatedBy, updatedAt, ...snapshot } = SETTINGS;
  assert.deepEqual(saved.settings, snapshot);
  assert.deepEqual(saved.slots[0], {
    fecha: WEEK, franja: "08:00", forecastDocs: 20, forecastVenta: 20000, required: 3, available: 5, suggested: 3, shortfall: 0, status: "ok",
  });

  assert.deepEqual(view.run, { id: "run-1", version: 1, method: saved.method, createdAt: "2026-11-21T15:00:00Z", createdBy: "u-planner", persisted: true });
  assert.equal(view.days.length, 7);
  assert.deepEqual(slotOf(view, WEEK, "08:00"), {
    franja: "08:00", forecastDocs: 20, required: 3, available: 5, suggested: 3, override: null, final: 3, difference: 0, shortfall: 0, status: "ok",
  });
  assert.deepEqual(view.flags, { noHistory: false, lowHistory: false, noProductivity: false });
  assert.equal(view.inputs.productivity, 40);
  assert.equal(view.inputs.poolSize, POOL.length);
});

test("the run uses the settings read at run time; past runs keep their own snapshot", async () => {
  const { service, state, repo } = setup();
  await service.computeRun(USER, "s1", WEEK);
  state.settings = { ...SETTINGS, utilization: 0.4 };
  const second = await service.computeRun(USER, "s1", WEEK);

  assert.equal(repo.runs[0].settings.utilization, 0.85);
  assert.equal(repo.runs[1].settings.utilization, 0.4);
  assert.equal(slotOf(second, WEEK, "08:00").required, 5); // ceil(80 / (40 * 0.4))
  assert.equal(second.settings.utilization, 0.4);
});

test("unknown or inactive sede -> 404 SEDE_NOT_MAPPED before any source is touched", async () => {
  const { service, calls } = setup();
  for (const id of ["nope", "s3"]) await rejectsWith(service.computeRun(USER, id, WEEK), 404, "SEDE_NOT_MAPPED");
  await rejectsWith(service.getWeek(USER, "s3", WEEK), 404, "SEDE_NOT_MAPPED");
  await rejectsWith(service.saveOverrides(USER, "s3", WEEK, [{ fecha: WEEK, franja: "08:00", value: 1 }]), 404, "SEDE_NOT_MAPPED");
  assert.deepEqual([calls.sales.length, calls.staff.length, calls.settings], [0, 0, 0]);
});

test("a failing source fails the run and nothing is saved (never an empty pool)", async () => {
  for (const [key, err] of [
    ["pool", createHttpError(503, "down", "STAFF_SOURCE_UNAVAILABLE")],
    ["history", createHttpError(503, "down", "SALES_DB_UNAVAILABLE")],
    ["absences", new Error("novedades down")],
  ]) {
    const { service, state, repo } = setup();
    state[key === "pool" ? "pool" : key === "history" ? "history" : "absences"] = err;
    await assert.rejects(service.computeRun(USER, "s1", WEEK), (e) => e === err, key);
    assert.equal(repo.calls.saveRun.length, 0, key);
  }
});

test("absences and a small pool produce a shortfall and carry the absence warnings", async () => {
  const absence = { id: "n1", cedula: "1001001", tipo: "Vacaciones", start: "2026-11-24", end: "2026-11-24" };
  const { service } = setup({ pool: POOL.slice(0, 2), absences: { absences: [absence], warnings: ["Absence n9 skipped"] } });
  const view = await service.computeRun(USER, "s1", WEEK);

  assert.equal(slotOf(view, "2026-11-23", "08:00").available, 2);
  assert.equal(slotOf(view, "2026-11-24", "08:00").available, 1);
  assert.deepEqual(
    [slotOf(view, "2026-11-24", "08:00").suggested, slotOf(view, "2026-11-24", "08:00").shortfall, slotOf(view, "2026-11-24", "08:00").status],
    [1, 2, "shortfall"],
  );
  assert.deepEqual(view.warnings, ["Absence n9 skipped"]);
});

test("no sales history: zeros, noHistory per day, nothing persisted, stale notice; GET shows the empty state", async () => {
  const { service, repo } = setup({ history: buildHistory({ from: "2026-01-02", to: "2026-01-01", dataAsOf: null, withProductivity: false }) });
  const view = await service.computeRun(USER, "s1", WEEK);

  assert.equal(repo.calls.saveRun.length, 0); // the RPC rejects runs without slots
  assert.deepEqual(view.run, { id: null, version: null, method: view.run.method, createdAt: "2026-11-21T15:00:00.000Z", createdBy: "u-planner", persisted: false });
  assert.equal(view.days.length, 7);
  for (const d of view.days) assert.deepEqual([d.noHistory, d.slots.length, d.forecast.docs], [true, 0, 0]);
  assert.deepEqual(view.flags, { noHistory: true, lowHistory: false, noProductivity: true });
  assert.equal(view.freshness.stale, true);
  assert.ok(view.freshness.notice.length > 0);

  const week = await service.getWeek(USER, "s1", WEEK);
  assert.deepEqual(week, { sedeId: "s1", weekStart: WEEK, run: null, freshness: null, flags: null, warnings: [], days: [] });
});

test("no productivity: required and suggested are null, status unknown, flag set", async () => {
  const { service, repo } = setup({ history: buildHistory({ withProductivity: false }) });
  const view = await service.computeRun(USER, "s1", WEEK);

  assert.deepEqual(slotOf(view, WEEK, "08:00"), {
    franja: "08:00", forecastDocs: 20, required: null, available: 5, suggested: null, override: null, final: null, difference: null, shortfall: null, status: "unknown",
  });
  assert.equal(view.flags.noProductivity, true);
  assert.equal(view.inputs.productivity, null);
  assert.equal(repo.calls.saveRun[0].slots[0].required, null);
});

test("thin history sets lowHistory on the day and the run flag", async () => {
  const { service } = setup({ history: buildHistory({ from: "2026-11-17", to: "2026-11-19", dataAsOf: "2026-11-20" }) });
  const view = await service.computeRun(USER, "s1", WEEK);
  const byDay = Object.fromEntries(view.days.map((d) => [d.fecha, [d.noHistory, d.lowHistory]]));

  assert.deepEqual(byDay["2026-11-24"], [false, true]); // Tuesday: one sample
  assert.deepEqual(byDay["2026-11-23"], [true, false]); // Monday: nothing comparable
  assert.equal(view.flags.lowHistory, true);
  assert.equal(view.flags.noHistory, false);
});

test("getWeek composes suggested / override / final / difference from the latest run", async () => {
  const { service } = setup();
  await service.computeRun(USER, "s1", WEEK);
  await service.saveOverrides(USER, "s1", WEEK, [{ fecha: WEEK, franja: "08:00", value: 5 }, { fecha: WEEK, franja: "08:15", value: 0 }]);
  const view = await service.getWeek(USER, "s1", WEEK);

  assert.deepEqual(
    [slotOf(view, WEEK, "08:00").suggested, slotOf(view, WEEK, "08:00").override, slotOf(view, WEEK, "08:00").final, slotOf(view, WEEK, "08:00").difference],
    [3, 5, 5, 2],
  );
  assert.deepEqual([slotOf(view, WEEK, "08:15").override, slotOf(view, WEEK, "08:15").final, slotOf(view, WEEK, "08:15").difference], [0, 0, -3]);
  assert.deepEqual([slotOf(view, WEEK, "08:30").override, slotOf(view, WEEK, "08:30").final, slotOf(view, WEEK, "08:30").difference], [null, 3, 0]);
});

test("recompute keeps overrides; removing one restores the current suggestion", async () => {
  const { service, state, repo } = setup();
  await service.computeRun(USER, "s1", WEEK);
  await service.saveOverrides(USER, "s1", WEEK, [{ fecha: WEEK, franja: "08:00", value: 5 }]);

  state.settings = { ...SETTINGS, utilization: 0.5 }; // suggestion becomes ceil(80 / 20) = 4
  const rerun = await service.computeRun(USER, "s1", WEEK);
  assert.equal(rerun.run.version, 2);
  assert.deepEqual(
    [slotOf(rerun, WEEK, "08:00").suggested, slotOf(rerun, WEEK, "08:00").override, slotOf(rerun, WEEK, "08:00").final],
    [4, 5, 5],
  );

  const removed = await service.saveOverrides(USER, "s1", WEEK, [{ fecha: WEEK, franja: "08:00", value: null }]);
  assert.deepEqual([slotOf(removed, WEEK, "08:00").override, slotOf(removed, WEEK, "08:00").final, slotOf(removed, WEEK, "08:00").difference], [null, 4, 0]);
  assert.equal(repo.overrides.size, 0);
});

test("saveOverrides records the author, the suggestion at edit time and removal as null", async () => {
  const { service, repo } = setup();
  await service.computeRun(USER, "s1", WEEK);
  await service.saveOverrides(USER, "s1", WEEK, [{ fecha: WEEK, franja: "08:00", value: 5 }, { fecha: WEEK, franja: "21:00", value: null }]);

  assert.deepEqual(repo.calls.applyOverrides[0], {
    sedeId: "s1",
    userId: "u-planner",
    items: [
      { fecha: WEEK, franja: "08:00", value: 5, suggestedAtEdit: 3 },
      { fecha: WEEK, franja: "21:00", value: null, suggestedAtEdit: null }, // slot outside the run
    ],
  });
});

test("saveOverrides on a week with no persisted run -> 409 NO_RUN and nothing is stored", async () => {
  const { service, repo } = setup();
  await assert.rejects(
    service.saveOverrides(USER, "s1", WEEK, [{ fecha: WEEK, franja: "08:00", value: 2 }]),
    (e) => e.statusCode === 409 && e.code === "NO_RUN" && e.message === "Calcula el sugerido de la semana antes de ajustarlo.",
  );
  assert.equal(repo.calls.applyOverrides.length, 0);
  assert.equal(repo.overrides.size, 0);
});

test("a no-history run is not persisted, so overrides on that week are also 409 NO_RUN", async () => {
  const { service } = setup({ history: buildHistory({ from: "2026-01-02", to: "2026-01-01", dataAsOf: null, withProductivity: false }) });
  await service.computeRun(USER, "s1", WEEK);
  await rejectsWith(service.saveOverrides(USER, "s1", WEEK, [{ fecha: WEEK, franja: "08:00", value: 2 }]), 409, "NO_RUN");
});

test("freshness is recomputed at read time with the injected clock, never stored", async () => {
  const { service, state, repo } = setup();
  await service.computeRun(USER, "s1", WEEK); // dataAsOf 2026-11-20, staleAfterDays 1
  const at = async (iso) => {
    state.now = new Date(iso);
    return (await service.getWeek(USER, "s1", WEEK)).freshness;
  };

  assert.deepEqual(await at("2026-11-21T15:00:00Z"), { dataAsOf: "2026-11-20", stale: false, notice: null }); // age 1 = threshold
  const stale = await at("2026-11-22T15:00:00Z"); // age 2
  assert.equal(stale.stale, true);
  assert.match(stale.notice, /2 days old/);
  assert.equal((await at("2026-11-22T03:00:00Z")).stale, false); // 22:00 on 2026-11-21 in Bogota: age 1, not 2
  assert.equal("freshness" in repo.runs[0] || "stale" in repo.runs[0].inputs, false);
  assert.equal(repo.runs.length, 1);
});

test("listSedes: admin and all-sedes callers see every active sede, scoped callers only theirs", async () => {
  const { service } = setup();
  const ids = async (access) => (await service.listSedes(access)).map((s) => s.sedeId);

  assert.deepEqual(await ids({ role: "admin", sedeIds: null }), ["s1", "s2"]); // inactive s3 hidden
  assert.deepEqual(await ids({ role: "admin", sedeIds: ["s2"] }), ["s1", "s2"]);
  assert.deepEqual(await ids({ role: "planner", sedeIds: null }), ["s1", "s2"]);
  assert.deepEqual(await ids({ role: "viewer", sedeIds: ["s2"] }), ["s2"]);
  assert.deepEqual(await ids({ role: "viewer", sedeIds: ["s3", "zz"] }), []);
});

test("the sales window is derived from the domain look-backs (holiday 730d dominates) plus the target week", async () => {
  const { service, calls } = setup();
  await service.computeRun(USER, "s1", WEEK);
  assert.equal(LOOKBACK, Math.max(HOLIDAY_LOOKBACK_DAYS, YEAR_OFFSET_DAYS + TREND_WINDOW_DAYS));
  assert.ok(LOOKBACK >= PRODUCTIVITY_WINDOW_DAYS && LOOKBACK >= RECENT_LOOKBACK_DAYS);
  assert.equal(calls.sales[0].desde, addDays(WEEK, -LOOKBACK));
  assert.equal(calls.sales[0].hasta, addDays(WEEK, 6));
});

test("recomputing a past week asks for that week's own horizon, not today's", async () => {
  const PAST = "2026-08-03";
  const { service, calls } = setup({ history: buildHistory({ from: "2026-06-01", to: "2026-08-02" }) });
  const view = await service.computeRun(USER, "s1", PAST);
  assert.deepEqual([calls.sales[0].desde, calls.sales[0].hasta], [addDays(PAST, -LOOKBACK), "2026-08-09"]);
  assert.equal(view.freshness.dataAsOf, "2026-08-02");
});

test("productivity ignores outlier rows on the dataAsOf day (partial day) but counts the day before", async () => {
  const history = buildHistory();
  history.productivityRows.push({ fecha: "2026-11-20", franja: "08:00", docs: 5000, cajeras: 1 });
  const { service } = setup({ history });
  assert.equal((await service.computeRun(USER, "s1", WEEK)).inputs.productivity, 40);

  const before = buildHistory();
  before.productivityRows.push({ fecha: "2026-11-19", franja: "08:00", docs: 5000, cajeras: 1 });
  const { service: s2 } = setup({ history: before });
  assert.ok((await s2.computeRun(USER, "s1", WEEK)).inputs.productivity > 40);
});

// Clock is Saturday 2026-11-21 -> current week starts Monday 2026-11-16.
const THIS_MONDAY = "2026-11-16";
const EARLIEST = addDays(THIS_MONDAY, -53 * 7);
const LATEST = addDays(THIS_MONDAY, 12 * 7);
const OUT_OF_RANGE_MESSAGE = "La semana está fuera del rango permitido.";

test("weekStart is bounded to 53 weeks back .. 12 weeks ahead: both edges pass, one step past each is 400 WEEK_OUT_OF_RANGE", async () => {
  for (const edge of [EARLIEST, LATEST]) {
    const { service } = setup();
    await service.getWeek(USER, "s1", edge);
    await service.computeRun(USER, "s1", edge);
    await service.saveOverrides(USER, "s1", edge, [{ fecha: edge, franja: "08:00", value: 1 }]).catch((e) => assert.notEqual(e.code, "WEEK_OUT_OF_RANGE")); // the range check passes
  }
  for (const outside of [addDays(EARLIEST, -7), addDays(LATEST, 7)]) {
    const { service, calls, repo } = setup();
    const item = [{ fecha: outside, franja: "08:00", value: 1 }];
    const isRangeError = (e) => e.statusCode === 400 && e.code === "WEEK_OUT_OF_RANGE" && e.message === OUT_OF_RANGE_MESSAGE;
    await assert.rejects(service.getWeek(USER, "s1", outside), isRangeError, outside);
    await assert.rejects(service.computeRun(USER, "s1", outside), isRangeError, outside);
    await assert.rejects(service.saveOverrides(USER, "s1", outside, item), isRangeError, outside);
    assert.deepEqual([calls.sales.length, calls.staff.length, repo.calls.saveRun.length, repo.calls.applyOverrides.length], [0, 0, 0, 0]);
  }
});

test("the weekStart bounds follow the injected clock", async () => {
  const { service, state } = setup();
  state.now = new Date("2027-11-20T15:00:00Z"); // one year later: the old WEEK is now ~52 weeks back
  await service.getWeek(USER, "s1", WEEK);
  state.now = new Date("2028-01-15T15:00:00Z");
  await rejectsWith(service.getWeek(USER, "s1", WEEK), 400, "WEEK_OUT_OF_RANGE");
});

test("the POST answers with the run it saved, even when another recompute saves in between", async () => {
  const { service, repo } = setup();
  // After the first save lands, a concurrent recompute saves a newer run before the first reads back.
  const realSave = repo.saveRun.bind(repo);
  let interleaved = false;
  repo.saveRun = async (run) => {
    const out = await realSave(run);
    if (!interleaved) {
      interleaved = true;
      await realSave({ ...run, createdBy: "u-other" });
    }
    return out;
  };

  const first = await service.computeRun(USER, "s1", WEEK);
  assert.deepEqual([first.run.id, first.run.version, first.run.createdBy], ["run-1", 1, "u-planner"]);
  assert.equal(repo.runs.length, 2); // the interleaved save did happen
  const latest = await service.getWeek(USER, "s1", WEEK);
  assert.equal(latest.run.version, 2); // GET still shows the newest run
});

test("an override on a slot with no suggestion is stored with suggestedAtEdit null and shows up on the next read", async () => {
  const { service, repo } = setup();
  await service.computeRun(USER, "s1", WEEK);
  const view = await service.saveOverrides(USER, "s1", WEEK, [{ fecha: WEEK, franja: "22:00", value: 2 }]); // store closes at 20:00

  assert.equal(repo.calls.applyOverrides[0].items[0].suggestedAtEdit, null);
  assert.equal(repo.overrides.get(`s1|${WEEK}|22:00`).suggestedAtEdit, null);
  assert.equal(repo.overrides.get(`s1|${WEEK}|22:00`).headcount, 2);
  const next = await service.getWeek(USER, "s1", WEEK);
  const slot = slotOf(next, WEEK, "22:00");
  assert.deepEqual([slot.suggested, slot.override, slot.final], [null, 2, 2]);
  assert.deepEqual(slotOf(view, WEEK, "22:00").final, 2);
});

test("the week range follows the Bogota date, not UTC: Sunday night in Bogota is still the previous week", async () => {
  // 2026-11-23T03:00:00Z is Sunday 2026-11-22 22:00 in Bogota, so the current Monday is 2026-11-16.
  const { service, state } = setup();
  state.now = new Date("2026-11-23T03:00:00Z");
  const latest = addDays("2026-11-16", 12 * 7); // 2027-02-08
  await service.getWeek(USER, "s1", latest);
  await rejectsWith(service.getWeek(USER, "s1", addDays(latest, 7)), 400, "WEEK_OUT_OF_RANGE");
  await rejectsWith(service.computeRun(USER, "s1", addDays(latest, 7)), 400, "WEEK_OUT_OF_RANGE");
  // Just after Bogota midnight (05:00Z) the new week has started and the window moves with it.
  state.now = new Date("2026-11-23T05:00:00Z");
  await service.getWeek(USER, "s1", addDays(latest, 7));
});

test("orphan overrides before, between and after the suggested slots keep the slots ordered, without duplicates", async () => {
  const { service } = setup();
  await service.computeRun(USER, "s1", WEEK); // suggested slots 08:00..20:00
  const view = await service.saveOverrides(USER, "s1", WEEK, [
    { fecha: WEEK, franja: "06:00", value: 1 }, // before the first suggested slot
    { fecha: WEEK, franja: "07:45", value: 2 },
    { fecha: WEEK, franja: "08:00", value: 5 }, // on an existing slot
    { fecha: WEEK, franja: "21:30", value: 1 }, // after the last one
  ]);
  const franjas = view.days.find((d) => d.fecha === WEEK).slots.map((s) => s.franja);

  assert.deepEqual(franjas.slice(0, 4), ["06:00", "07:45", "08:00", "08:15"]);
  assert.equal(franjas.at(-1), "21:30");
  assert.equal(franjas.length, SLOTS_PER_OPEN_DAY + 3);
  assert.equal(new Set(franjas).size, franjas.length);
  assert.deepEqual(franjas, [...franjas].sort());
  assert.deepEqual([slotOf(view, WEEK, "08:00").suggested, slotOf(view, WEEK, "08:00").override, slotOf(view, WEEK, "08:00").final], [3, 5, 5]);
  assert.deepEqual([slotOf(view, WEEK, "06:00").suggested, slotOf(view, WEEK, "06:00").final], [null, 1]);
});
