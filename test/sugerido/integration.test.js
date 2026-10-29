import test from "node:test";
import assert from "node:assert/strict";

import { POOL, SETTINGS, SLOTS_PER_OPEN_DAY, WEEK, buildHistory, withSugeridoApp } from "./api.helpers.js";
import { createAbsencesPort } from "../../src/modules/sugerido/repositories/absences.port.js";
import { addDays } from "../../src/modules/sugerido/domain/dates.js";

// End to end through createApp + real router + real service + real domain, with fakes only at the
// edges (sales, staff, novedades, suggestions storage). Each scenario is one HTTP conversation.

const weekPath = (week = WEEK, sede = "s1") => `/sedes/${sede}/weeks/${week}`;
const run = (call, token = "t-planner", week = WEEK) => call("POST", `${weekPath(week)}/runs`, token);
const slot = (view, fecha, franja) => view.days.find((d) => d.fecha === fecha).slots.find((s) => s.franja === franja);

/** Novedades fake with the contract of createNovedadesRepo.listActiveOverlapping (range + tipo filter). */
function fakeNovedades(rows) {
  const state = { rows };
  const repo = {
    async listActiveOverlapping({ desde, hasta, tipos }) {
      return state.rows.filter((r) => !r.anulada && r.fecha_inicio <= hasta && r.fecha_fin >= desde && tipos.includes(r.tipo));
    },
  };
  return { state, absencesPort: createAbsencesPort(repo) };
}
const novedad = (o = {}) => ({
  id: "n1", cedula: POOL[0], tipo: "Vacaciones", fecha_inicio: WEEK, fecha_fin: addDays(WEEK, 6), anulada: false, ...o,
});

test("4+ weeks of history: a full week with slot values, inputs and fresh data, readable again with GET", () =>
  withSugeridoApp({}, async ({ call }) => {
    const created = await run(call);
    assert.equal(created.status, 201);
    const view = created.json.data;
    assert.equal(view.days.length, 7);
    for (const d of view.days) assert.equal(d.slots.length, SLOTS_PER_OPEN_DAY, d.fecha);
    assert.deepEqual(view.flags, { noHistory: false, lowHistory: false, noProductivity: false });
    assert.deepEqual([view.freshness.stale, view.freshness.notice, view.freshness.dataAsOf], [false, null, "2026-11-20"]);
    assert.equal(view.inputs.poolSize, POOL.length);
    assert.deepEqual(
      [slot(view, WEEK, "08:00").required, slot(view, WEEK, "08:00").suggested, slot(view, WEEK, "08:00").shortfall],
      [3, 3, 0],
    );

    const read = await call("GET", weekPath(), "t-viewer");
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.data.days, view.days);
  }));

test("stale data: the notice and dataAsOf are returned, and the clock decides it at read time", () =>
  withSugeridoApp({}, async ({ call, state }) => {
    state.now = new Date("2026-11-23T15:00:00Z"); // data ends 2026-11-20: 3 days old, limit is 1
    const view = (await run(call)).json.data;
    assert.equal(view.freshness.stale, true);
    assert.equal(view.freshness.dataAsOf, "2026-11-20");
    assert.match(view.freshness.notice, /3 days old/);

    state.now = new Date("2026-11-21T15:00:00Z"); // an earlier clock reads the same run as fresh
    assert.equal((await call("GET", weekPath(), "t-viewer")).json.data.freshness.stale, false);
  }));

test("thin history: lowHistory on the day and on the run, with the samples that exist", () =>
  withSugeridoApp({ history: buildHistory({ from: "2026-11-17", to: "2026-11-19", dataAsOf: "2026-11-20" }) }, async ({ call }) => {
    const view = (await run(call)).json.data;
    const tuesday = view.days.find((d) => d.fecha === "2026-11-24");
    const monday = view.days.find((d) => d.fecha === WEEK);
    assert.deepEqual([tuesday.noHistory, tuesday.lowHistory], [false, true]);
    assert.deepEqual([monday.noHistory, monday.lowHistory], [true, false]);
    assert.deepEqual([view.flags.lowHistory, view.flags.noHistory], [true, false]);
  }));

test("unmapped or inactive sede: 404 SEDE_NOT_MAPPED, no source is read and nothing is assumed", () =>
  withSugeridoApp({}, async ({ call, calls, repo }) => {
    for (const sede of ["nope", "s3"]) {
      const token = "t-admin"; // admin passes the scope check, so the error is the mapping one
      for (const [m, p, b] of [
        ["GET", weekPath(WEEK, sede)], ["POST", `${weekPath(WEEK, sede)}/runs`], ["PUT", `${weekPath(WEEK, sede)}/overrides`, [{ fecha: WEEK, franja: "08:00", value: 1 }]],
      ]) {
        const r = await call(m, p, token, b);
        assert.deepEqual([r.status, r.json.code], [404, "SEDE_NOT_MAPPED"], `${m} ${sede}`);
      }
    }
    assert.deepEqual([calls.sales.length, calls.staff.length, calls.absences.length], [0, 0, 0]);
    assert.equal(repo.runs.length, 0);
    const listed = (await call("GET", "/sedes", "t-admin")).json.data.map((s) => s.sedeId);
    assert.deepEqual(listed, ["s1", "s2"]);
  }));

test("overtime cap: hours beyond 42 + 12 per cashier are reported as a weekly shortfall", async () => {
  // Week demand is 257.25 cashier-hours (3 cashiers x 49 slots x 7 days / 4).
  const capacityFor = (pool, patch) =>
    withSugeridoApp({ pool }, async ({ call }) => {
      if (patch) assert.equal((await call("PUT", "/settings", "t-admin", patch)).status, 200);
      capacityFor.last = (await run(call)).json.data.capacity;
    }).then(() => capacityFor.last);

  const five = await capacityFor(POOL); // 5 x 42 = 210 ordinary, 5 x 54 = 270 with overtime
  assert.deepEqual(five, { requiredH: 257.25, ordinaryCapH: 210, maxCapH: 270, overtimeNeeded: true, weeklyShortfall: false });

  const four = await capacityFor(POOL.slice(0, 4)); // 216 maximum: the demand no longer fits
  assert.deepEqual([four.maxCapH, four.overtimeNeeded, four.weeklyShortfall], [216, true, true]);

  const noOvertime = await capacityFor(POOL, { overtimeWeeklyHours: 0.25 }); // the cap follows the editable setting
  assert.deepEqual([noOvertime.maxCapH, noOvertime.weeklyShortfall], [211.25, true]);
});

test("a cancelled novedad frees the cashier; an active one removes them on the days it covers", () => {
  const { state, absencesPort } = fakeNovedades([novedad()]);
  return withSugeridoApp({ pool: POOL.slice(0, 1), absencesPort }, async ({ call }) => {
    const blocked = (await run(call)).json.data;
    assert.equal(slot(blocked, WEEK, "08:00").available, 0);
    assert.equal(slot(blocked, WEEK, "08:00").suggested, 0);
    assert.equal(slot(blocked, WEEK, "08:00").shortfall, 3);

    state.rows = [novedad({ anulada: true })]; // soft-cancelled
    const freed = (await run(call)).json.data;
    assert.equal(slot(freed, WEEK, "08:00").available, 1);
    assert.equal(slot(freed, WEEK, "08:00").suggested, 1);
  });
});

test("an absence only removes the cashier on the days it covers", () => {
  const { absencesPort } = fakeNovedades([novedad({ fecha_inicio: "2026-11-17", fecha_fin: "2026-11-24" })]); // Mon + Tue of the target week
  return withSugeridoApp({ pool: POOL.slice(0, 2), absencesPort }, async ({ call }) => {
    const view = (await run(call)).json.data;
    assert.equal(slot(view, "2026-11-23", "08:00").available, 1);
    assert.equal(slot(view, "2026-11-24", "08:00").available, 1);
    assert.equal(slot(view, "2026-11-25", "08:00").available, 2);
  });
});

test("a novedad for a cedula outside the pool has no effect", async () => {
  let expected;
  await withSugeridoApp({ pool: POOL.slice(0, 2) }, async ({ call }) => {
    expected = (await run(call)).json.data;
  });
  const { absencesPort } = fakeNovedades([novedad({ cedula: "9999999" })]);
  await withSugeridoApp({ pool: POOL.slice(0, 2), absencesPort }, async ({ call }) => {
    const view = (await run(call)).json.data;
    assert.deepEqual(view.days, expected.days);
    assert.deepEqual(view.capacity, expected.capacity);
  });
});

test("a novedad stored with leading zeros removes the same cashier from the pool", () => {
  const { absencesPort } = fakeNovedades([novedad({ cedula: "00" + POOL[0] })]);
  return withSugeridoApp({ pool: POOL.slice(0, 1), absencesPort }, async ({ call }) => {
    const view = (await run(call)).json.data;
    assert.equal(slot(view, WEEK, "08:00").available, 0);
  });
});

test("override then recompute: the override survives, the suggestion changes, removing it restores the suggestion", () =>
  withSugeridoApp({}, async ({ call }) => {
    await run(call);
    const put = await call("PUT", `${weekPath()}/overrides`, "t-planner", [{ fecha: WEEK, franja: "08:00", value: 5 }]);
    assert.equal(put.status, 200);
    assert.deepEqual(
      [slot(put.json.data, WEEK, "08:00").suggested, slot(put.json.data, WEEK, "08:00").override, slot(put.json.data, WEEK, "08:00").final],
      [3, 5, 5],
    );

    // The admin raises the cashier utilisation target: demand per cashier changes the suggestion to 4.
    assert.equal((await call("PUT", "/settings", "t-admin", { utilization: 0.5 })).status, 200);
    const rerun = (await run(call)).json.data;
    assert.equal(rerun.run.version, 2);
    assert.deepEqual(
      [slot(rerun, WEEK, "08:00").suggested, slot(rerun, WEEK, "08:00").override, slot(rerun, WEEK, "08:00").final, slot(rerun, WEEK, "08:00").difference],
      [4, 5, 5, 1],
    );
    assert.equal(rerun.settings.utilization, 0.5);

    const removed = await call("PUT", `${weekPath()}/overrides`, "t-planner", [{ fecha: WEEK, franja: "08:00", value: null }]);
    assert.deepEqual(
      [slot(removed.json.data, WEEK, "08:00").override, slot(removed.json.data, WEEK, "08:00").final],
      [null, 4],
    );
    assert.equal(SETTINGS.utilization, 0.85); // the shared fixture is not mutated by the scenario
  }));
