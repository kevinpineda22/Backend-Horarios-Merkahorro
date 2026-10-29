import test from "node:test";
import assert from "node:assert/strict";

import { WEEK, SETTINGS, withSugeridoApp } from "./api.helpers.js";

const KEYS = ["ordinaryWeeklyHours", "overtimeWeeklyHours", "dailyMaxHours", "utilization", "maxWorkingDaysPerWeek", "minCashiers", "staleAfterDays", "blockingAbsenceTypes"];
const weekPath = `/sedes/s1/weeks/${WEEK}`;

test("settings: no token is 401; non-admin roles and users without access are 403, even with an invalid body", () =>
  withSugeridoApp({}, async ({ call, calls }) => {
    for (const [m, b] of [["GET"], ["PUT", { utilization: 0.8 }], ["PUT", { utilization: 99 }], ["PUT", {}]]) {
      assert.equal((await call(m, "/settings", null, b)).status, 401, `${m} no token`);
      for (const token of ["t-planner", "t-viewer", "t-norole"]) {
        const r = await call(m, "/settings", token, b);
        assert.deepEqual([r.status, r.json?.code], [403, "FORBIDDEN_ROLE"], `${m} ${token} ${JSON.stringify(b)}`);
      }
    }
    assert.equal(calls.updateSettings.length, 0);
  }));

test("settings: admin GET returns every tunable parameter", () =>
  withSugeridoApp({}, async ({ call }) => {
    const r = await call("GET", "/settings", "t-admin");
    assert.equal(r.status, 200);
    for (const k of KEYS) assert.deepEqual(r.json.data[k], SETTINGS[k], k);
    assert.equal(r.json.data.updatedAt, SETTINGS.updatedAt);
  }));

test("settings: admin PUT applies a partial update and records the authenticated user", () =>
  withSugeridoApp({}, async ({ call, calls }) => {
    const r = await call("PUT", "/settings", "t-admin", { utilization: 0.8, minCashiers: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.utilization, 0.8);
    assert.equal(r.json.data.minCashiers, 2);
    assert.equal(r.json.data.ordinaryWeeklyHours, 42); // untouched keys keep their value
    assert.deepEqual(calls.updateSettings, [{ patch: { utilization: 0.8, minCashiers: 2 }, userId: "u-admin" }]);
    assert.equal((await call("GET", "/settings", "t-admin")).json.data.utilization, 0.8);
  }));

test("settings: boundary values are accepted", () =>
  withSugeridoApp({}, async ({ call }) => {
    for (const patch of [{ utilization: 1 }, { utilization: 0.1 }, { dailyMaxHours: 24 }, { maxWorkingDaysPerWeek: 1 }, { maxWorkingDaysPerWeek: 7 }, { minCashiers: 0 }, { staleAfterDays: 0 }, { blockingAbsenceTypes: [] }, { overtimeWeeklyHours: 0.5 }]) {
      assert.equal((await call("PUT", "/settings", "t-admin", patch)).status, 200, JSON.stringify(patch));
    }
  }));

test("settings: out-of-range or malformed values are 400 and the previous value is kept", () =>
  withSugeridoApp({}, async ({ call, calls }) => {
    const invalid = [
      { utilization: 0 }, { utilization: 1.01 }, { utilization: -0.5 }, { utilization: "0.8" }, { utilization: null },
      // A typo near zero would make headcount = docs / (productivity * utilization) explode for every sede.
      { utilization: 0.09 }, { utilization: 1e-320 },
      { ordinaryWeeklyHours: 0 }, { ordinaryWeeklyHours: -1 }, { ordinaryWeeklyHours: 169 },
      { overtimeWeeklyHours: 0 }, { overtimeWeeklyHours: -3 },
      { dailyMaxHours: 0 }, { dailyMaxHours: 24.5 },
      { maxWorkingDaysPerWeek: 0 }, { maxWorkingDaysPerWeek: 8 }, { maxWorkingDaysPerWeek: 2.5 },
      { minCashiers: -1 }, { minCashiers: 1.5 },
      { staleAfterDays: -1 }, { staleAfterDays: 0.5 },
      { blockingAbsenceTypes: ["Sabático"] }, { blockingAbsenceTypes: "Vacaciones" }, { blockingAbsenceTypes: ["Vacaciones", 3] },
      { utilization: 0.8, minCashiers: -1 }, // one bad key rejects the whole patch
      {}, { unknownKey: 1 }, [],
    ];
    for (const body of invalid) {
      const r = await call("PUT", "/settings", "t-admin", body);
      assert.deepEqual([r.status, r.json?.code], [400, "VALIDATION_ERROR"], JSON.stringify(body));
    }
    assert.equal(calls.updateSettings.length, 0, "nothing reached the repository");
    const kept = (await call("GET", "/settings", "t-admin")).json.data;
    for (const k of KEYS) assert.deepEqual(kept[k], SETTINGS[k], k);
  }));

test("settings: unknown keys are stripped before reaching the repository (no audit spoofing)", () =>
  withSugeridoApp({}, async ({ call, calls }) => {
    const r = await call("PUT", "/settings", "t-admin", { utilization: 0.7, updatedBy: "someone-else", id: 2, updatedAt: "2000-01-01" });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.updateSettings, [{ patch: { utilization: 0.7 }, userId: "u-admin" }]);
  }));

test("settings: blockingAbsenceTypes accepts a subset of the six tipos and drops repeats", () =>
  withSugeridoApp({}, async ({ call, calls }) => {
    const r = await call("PUT", "/settings", "t-admin", { blockingAbsenceTypes: ["Vacaciones", "Día de la Familia", "Vacaciones"] });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.updateSettings[0].patch.blockingAbsenceTypes, ["Vacaciones", "Día de la Familia"]);
  }));

test("settings: the next run uses the new value; a past run keeps its snapshot", () =>
  withSugeridoApp({}, async ({ call, repo }) => {
    const first = await call("POST", `${weekPath}/runs`, "t-admin");
    assert.equal(first.status, 201);
    assert.equal(first.json.data.settings.utilization, 0.85);

    assert.equal((await call("PUT", "/settings", "t-admin", { utilization: 0.5 })).status, 200);

    // The stored run and the week read are untouched by the change.
    assert.equal(repo.runs[0].settings.utilization, 0.85);
    assert.equal((await call("GET", weekPath, "t-admin")).json.data.settings.utilization, 0.85);

    const second = await call("POST", `${weekPath}/runs`, "t-admin");
    assert.equal(second.json.data.settings.utilization, 0.5);
    assert.equal(repo.runs[1].settings.utilization, 0.5);
    assert.equal(repo.runs[0].settings.utilization, 0.85, "version 1 snapshot is unchanged");
  }));
