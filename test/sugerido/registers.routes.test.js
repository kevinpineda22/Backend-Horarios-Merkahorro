import test from "node:test";
import assert from "node:assert/strict";

import { WEEK, withSugeridoApp } from "./api.helpers.js";

const REGISTERS = { B1: 6, B2: 4, B3: 3 };
const path = (sedeId = "s1") => `/sedes/${sedeId}/registers`;
const weekPath = `/sedes/s1/weeks/${WEEK}`;

test("PUT registers: no token is 401; planner, viewer and no-role users are 403 even with an invalid body", () =>
  withSugeridoApp({ registers: REGISTERS }, async ({ call, calls, repo }) => {
    for (const body of [{ override: 5 }, { override: 99 }, {}]) {
      assert.equal((await call("PUT", path(), null, body)).status, 401);
      for (const token of ["t-planner", "t-viewer", "t-norole"]) {
        const r = await call("PUT", path(), token, body);
        assert.deepEqual([r.status, r.json?.code], [403, "FORBIDDEN_ROLE"], `${token} ${JSON.stringify(body)}`);
      }
    }
    assert.equal(repo.calls.setRegistersOverride.length, 0);
    assert.equal(calls.registers.length, 0);
  }));

test("PUT registers: admin sets the override and gets { derived, override, effective }", () =>
  withSugeridoApp({ registers: REGISTERS }, async ({ call, repo }) => {
    const r = await call("PUT", path(), "t-admin", { override: 8 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, { derived: 10, override: 8, effective: 8 });
    assert.deepEqual(repo.calls.setRegistersOverride, [{ sedeId: "s1", override: 8 }]);

    const cleared = await call("PUT", path(), "t-admin", { override: null });
    assert.deepEqual([cleared.status, cleared.json.data], [200, { derived: 10, override: null, effective: 10 }]);
  }));

test("PUT registers: admin may use boundary values 1 and 50", () =>
  withSugeridoApp({ registers: REGISTERS }, async ({ call }) => {
    for (const override of [1, 50]) assert.equal((await call("PUT", path(), "t-admin", { override })).status, 200, String(override));
  }));

test("PUT registers: invalid bodies are 400 VALIDATION_ERROR and nothing is written", () =>
  withSugeridoApp({ registers: REGISTERS }, async ({ call, repo }) => {
    for (const body of [{ override: 0 }, { override: 51 }, { override: -2 }, { override: 3.5 }, { override: "7" }, {}]) {
      const r = await call("PUT", path(), "t-admin", body);
      assert.deepEqual([r.status, r.json.code], [400, "VALIDATION_ERROR"], JSON.stringify(body));
      assert.equal(r.json.details[0].path, "body.override");
    }
    assert.equal(repo.calls.setRegistersOverride.length, 0);
  }));

test("PUT registers: unknown or inactive sede is 404 SEDE_NOT_MAPPED", () =>
  withSugeridoApp({ registers: REGISTERS }, async ({ call }) => {
    for (const sedeId of ["nope", "s3"]) {
      const r = await call("PUT", path(sedeId), "t-admin", { override: 5 });
      assert.deepEqual([r.status, r.json.code], [404, "SEDE_NOT_MAPPED"], sedeId);
    }
  }));

test("GET sedes: every item has registers, for admins and for scoped users", () =>
  withSugeridoApp({ registers: REGISTERS }, async ({ call }) => {
    const admin = await call("GET", "/sedes", "t-admin");
    assert.deepEqual(admin.json.data.map((s) => [s.sedeId, s.registers]), [
      ["s1", { derived: 10, override: null, effective: 10 }],
      ["s2", { derived: 3, override: null, effective: 3 }],
    ]);
    const viewer = await call("GET", "/sedes", "t-viewer");
    assert.deepEqual(viewer.json.data.map((s) => s.sedeId), ["s1"]);
    assert.equal(viewer.json.data[0].registers.effective, 10);
  }));

test("GET week: carries the current registers, also reflecting a new override", () =>
  withSugeridoApp({ registers: REGISTERS }, async ({ call }) => {
    assert.deepEqual((await call("GET", weekPath, "t-viewer")).json.data.registers, { derived: 10, override: null, effective: 10 });
    await call("PUT", path(), "t-admin", { override: 6 });
    assert.deepEqual((await call("GET", weekPath, "t-viewer")).json.data.registers, { derived: 10, override: 6, effective: 6 });
  }));

test("POST run caps the suggestion; PUT overrides above the registers answer 422 REGISTERS_EXCEEDED with details", () =>
  withSugeridoApp({ registers: { B1: 1, B2: 1 } }, async ({ call, repo }) => {
    const run = await call("POST", `${weekPath}/runs`, "t-planner");
    assert.equal(run.status, 201);
    assert.equal(run.json.data.days[0].slots[0].suggested, 2);
    assert.equal(run.json.data.days[0].slots[0].required, 3);

    const r = await call("PUT", `${weekPath}/overrides`, "t-planner", [{ fecha: WEEK, franja: "08:00", value: 3 }]);
    assert.equal(r.status, 422);
    assert.equal(r.json.code, "REGISTERS_EXCEEDED");
    assert.equal(r.json.error, "La sede tiene 2 puestos de pago: no puedes programar más cajeras a la vez.");
    assert.deepEqual(r.json.details, { registers: 2, exceeded: [{ fecha: WEEK, franja: "08:00", value: 3 }] });
    assert.equal(repo.calls.applyOverrides.length, 0);

    const ok = await call("PUT", `${weekPath}/overrides`, "t-planner", [{ fecha: WEEK, franja: "08:00", value: 2 }]);
    assert.equal(ok.status, 200);
  }));
