import test from "node:test";
import assert from "node:assert/strict";

import { createOverridesBodySchema, weekParamsSchema } from "../../src/modules/sugerido/sugerido.schemas.js";

const WEEK = "2026-11-02"; // Monday
const item = (o = {}) => ({ fecha: "2026-11-02", franja: "08:00", value: 3, ...o });
const parseBody = (body, week = WEEK) => createOverridesBodySchema(week).safeParse(body);
const messages = (r) => r.error.issues.map((i) => i.message).join("|");

test("weekParams: accepts a Monday and a non-empty sedeId", () => {
  const r = weekParamsSchema.safeParse({ sedeId: "s1", weekStart: WEEK });
  assert.equal(r.success, true);
  assert.deepEqual(r.data, { sedeId: "s1", weekStart: WEEK });
});

test("weekParams: rejects non-Mondays (both neighbours), bad formats and impossible dates", () => {
  for (const weekStart of ["2026-11-01", "2026-11-03", "2026-11-08", "2026-02-30", "2026-11-2", "2026-11-02T00:00:00Z", "", "abc"]) {
    assert.equal(weekParamsSchema.safeParse({ sedeId: "s1", weekStart }).success, false, weekStart);
  }
  assert.equal(weekParamsSchema.safeParse({ sedeId: "s1" }).success, false);
});

test("weekParams: sedeId must be a non-blank string; surrounding spaces are trimmed", () => {
  assert.equal(weekParamsSchema.safeParse({ sedeId: "", weekStart: WEEK }).success, false);
  assert.equal(weekParamsSchema.safeParse({ sedeId: "   ", weekStart: WEEK }).success, false);
  assert.equal(weekParamsSchema.safeParse({ weekStart: WEEK }).success, false);
  assert.equal(weekParamsSchema.safeParse({ sedeId: " s1 ", weekStart: WEEK }).data.sedeId, "s1");
});

test("weekParams: unknown keys are stripped", () => {
  const r = weekParamsSchema.safeParse({ sedeId: "s1", weekStart: WEEK, extra: 1 });
  assert.deepEqual(r.data, { sedeId: "s1", weekStart: WEEK });
});

test("overrides body: valid items pass, including value null (remove) and value 0", () => {
  const r = parseBody([item(), item({ franja: "08:15", value: 0 }), item({ franja: "08:30", value: null })]);
  assert.equal(r.success, true);
  assert.deepEqual(r.data.map((i) => i.value), [3, 0, null]);
});

test("overrides body: must be a non-empty array of at most 700 items", () => {
  assert.equal(parseBody({}).success, false);
  assert.equal(parseBody(null).success, false);
  assert.equal(parseBody([]).success, false);
  // A week has 7 x 96 = 672 distinct slots, so the 700 boundary is observed through the size message:
  // 700 items (28 repeated keys) only trip the duplicate rule, 701 also trips the size rule.
  const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
  const franjas = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${["00", "15", "30", "45"][i % 4]}`);
  const all = days.flatMap((fecha) => franjas.map((franja) => item({ fecha, franja })));
  assert.equal(all.length, 672);
  assert.equal(parseBody(all).success, true);
  const at700 = parseBody([...all, ...all.slice(0, 28)]);
  assert.equal(at700.success, false);
  assert.doesNotMatch(messages(at700), /700/);
  const at701 = parseBody([...all, ...all.slice(0, 29)]);
  assert.equal(at701.success, false);
  assert.match(messages(at701), /700/);
});

test("overrides body: value must be a non-negative integer or null", () => {
  for (const value of [-1, 1.5, "3", undefined, NaN, true, 2147483648]) {
    assert.equal(parseBody([item({ value })]).success, false, String(value));
  }
  assert.equal(parseBody([{ fecha: "2026-11-02", franja: "08:00" }]).success, false);
  assert.equal(parseBody([item({ value: 2147483647 })]).success, true);
});

test("overrides body: franja must be HH:MM on a 15-minute boundary", () => {
  for (const franja of ["08:00", "08:15", "08:30", "08:45", "00:00", "23:45"]) {
    assert.equal(parseBody([item({ franja })]).success, true, franja);
  }
  for (const franja of ["08:10", "08:01", "8:00", "24:00", "23:60", "08:00:00", "", "08-00", 800]) {
    assert.equal(parseBody([item({ franja })]).success, false, String(franja));
  }
});

test("overrides body: fecha must be a real date inside the target week (both edges inclusive)", () => {
  assert.equal(parseBody([item({ fecha: "2026-11-02" })]).success, true); // Monday
  assert.equal(parseBody([item({ fecha: "2026-11-08" })]).success, true); // Sunday
  assert.equal(parseBody([item({ fecha: "2026-11-01" })]).success, false);
  assert.equal(parseBody([item({ fecha: "2026-11-09" })]).success, false);
  assert.equal(parseBody([item({ fecha: "2026-02-30" })]).success, false);
  assert.equal(parseBody([item({ fecha: "bad" })]).success, false);
  assert.equal(parseBody([item({ fecha: undefined })]).success, false);
});

test("overrides body: duplicate (fecha, franja) keys are rejected, same franja on other days is fine", () => {
  const dup = parseBody([item(), item({ value: 5 })]);
  assert.equal(dup.success, false);
  assert.match(messages(dup), /duplicad/i);
  assert.deepEqual(dup.error.issues[0].path, [1]);
  assert.equal(parseBody([item(), item({ fecha: "2026-11-03" }), item({ franja: "08:15" })]).success, true);
});

test("overrides body: unknown keys on items are stripped", () => {
  const r = parseBody([{ ...item(), reason: "x", updatedBy: "evil" }]);
  assert.deepEqual(r.data, [item()]);
});

test("overrides body: an invalid weekStart still builds a schema (params validation reports it)", () => {
  assert.equal(parseBody([item()], "not-a-date").success, true);
  assert.equal(parseBody([item({ fecha: "bad" })], "not-a-date").success, false);
});

test("overrides body: every minute value other than :00/:15/:30/:45 is rejected (exhaustive)", () => {
  for (let m = 0; m < 60; m++) {
    const franja = `08:${String(m).padStart(2, "0")}`;
    assert.equal(parseBody([item({ franja })]).success, [0, 15, 30, 45].includes(m), franja);
  }
});

test("overrides body: franja minutes :05/:14/:50/:59 are rejected at the day edges and mid-day; :00/:15/:30/:45 pass at 00:00 and 23:45", () => {
  for (const franja of ["00:05", "00:14", "00:50", "00:59", "12:50", "23:05", "23:14", "23:50", "23:59"]) {
    assert.equal(parseBody([item({ franja })]).success, false, franja);
  }
  for (const franja of ["00:00", "00:15", "00:30", "00:45", "23:00", "23:15", "23:30", "23:45"]) {
    assert.equal(parseBody([item({ franja })]).success, true, franja);
  }
});
