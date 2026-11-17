import test from "node:test";
import assert from "node:assert/strict";

import { withSugeridoApp } from "./api.helpers.js";

const WEEK = "2026-11-02";
const snapshotsRepo = { async findLatestByWeek() { return null; } };
const path = (w = WEEK, sede = "s1") => `/sedes/${sede}/accuracy?weekStart=${w}`;

test("accuracy: no token is 401; planner, viewer and users without access are 403", () =>
  withSugeridoApp({ snapshotsRepo }, async ({ call }) => {
    assert.equal((await call("GET", path())).status, 401);
    for (const token of ["t-planner", "t-viewer", "t-norole"]) {
      const r = await call("GET", path(), token);
      assert.deepEqual([r.status, r.json?.code], [403, "FORBIDDEN_ROLE"], token);
    }
  }));

test("accuracy: weekStart must be a Monday and a real date", () =>
  withSugeridoApp({ snapshotsRepo }, async ({ call }) => {
    for (const w of ["2026-11-03", "2026-02-30", "nope"]) {
      const r = await call("GET", path(w), "t-admin");
      assert.equal(r.status, 400, w);
    }
    assert.equal((await call("GET", "/sedes/s1/accuracy", "t-admin")).status, 400);
  }));

test("accuracy: admin gets 200 with a status for a closed week without snapshot; unmapped sede is 404", () =>
  withSugeridoApp({ snapshotsRepo }, async ({ call }) => {
    const r = await call("GET", path(), "t-admin");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.status, "NO_SNAPSHOT");
    assert.equal(r.json.data.weekEnd, "2026-11-08");
    assert.equal((await call("GET", path(WEEK, "nope"), "t-admin")).status, 404);
  }));
