import test from "node:test";
import assert from "node:assert/strict";
import {
  historyQuerySchema,
  publishBodySchema,
  saveBodySchema,
  weekParamsSchema,
} from "../../src/modules/horarios/horarios.schemas.js";

const shift = (over = {}) => ({
  cedula: "11111111", fecha: "2031-01-06", tipo: "TRABAJO", startTime: "08:00", endTime: "17:00",
  lunchStart: null, cargo: null, observacion: null, ...over,
});
const body = (over = {}) => ({ expectedVersion: 0, cedulas: ["11111111"], shifts: [shift()], ...over });
const ok = (schema, v) => assert.equal(schema.safeParse(v).success, true, JSON.stringify(schema.safeParse(v).error?.issues));
const bad = (schema, v) => assert.equal(schema.safeParse(v).success, false);

test("weekStart must be a real ISO Monday", () => {
  ok(weekParamsSchema, { sedeId: "copacabana", weekStart: "2031-01-06" });
  bad(weekParamsSchema, { sedeId: "copacabana", weekStart: "2031-01-07" }); // Tuesday
  bad(weekParamsSchema, { sedeId: "copacabana", weekStart: "2031-02-30" });
  bad(weekParamsSchema, { sedeId: "copacabana", weekStart: "06-01-2031" });
  bad(weekParamsSchema, { sedeId: "", weekStart: "2031-01-06" });
});

test("save body accepts a valid payload and an empty shift list", () => {
  ok(saveBodySchema, body());
  ok(saveBodySchema, body({ shifts: [] }));
  ok(saveBodySchema, body({ shifts: [shift({ breakMinutes: 60, lunchStart: "12:00", cargo: "Cajero" })] }));
});

test("expectedVersion is a non-negative integer", () => {
  bad(saveBodySchema, body({ expectedVersion: -1 }));
  bad(saveBodySchema, body({ expectedVersion: 1.5 }));
  bad(saveBodySchema, body({ expectedVersion: "0" }));
  ok(saveBodySchema, { cedulas: ["11111111"], shifts: [] }); // absent = 0
});

test("cedulas: 1..300, valid, unique", () => {
  bad(saveBodySchema, body({ cedulas: [] }));
  bad(saveBodySchema, body({ cedulas: ["12"] }));
  bad(saveBodySchema, body({ cedulas: ["11111111", "11111111"] }));
  ok(saveBodySchema, body({ cedulas: Array.from({ length: 300 }, (_, i) => String(10000000 + i)), shifts: [] }));
  bad(saveBodySchema, body({ cedulas: Array.from({ length: 301 }, (_, i) => String(10000000 + i)), shifts: [] }));
});

test("shifts: at most 2100, tipo enum, formats, lengths", () => {
  ok(saveBodySchema, body({ shifts: Array.from({ length: 2100 }, () => shift()) }));
  bad(saveBodySchema, body({ shifts: Array.from({ length: 2101 }, () => shift()) }));
  bad(saveBodySchema, body({ shifts: [shift({ tipo: "VACACIONES" })] }));
  bad(saveBodySchema, body({ shifts: [shift({ fecha: "2031-1-6" })] }));
  bad(saveBodySchema, body({ shifts: [shift({ cedula: "abc" })] }));
  bad(saveBodySchema, body({ shifts: [shift({ cargo: "x".repeat(121) })] }));
  bad(saveBodySchema, body({ shifts: [shift({ observacion: "x".repeat(501) })] }));
  bad(saveBodySchema, body({ shifts: [shift({ breakMinutes: "60" })] }));
});

test("save body strips derived or audit fields", () => {
  const out = saveBodySchema.parse(body({ shifts: [shift({ need: 3, coverage: 2, created_by: "x" })], published: true }));
  assert.deepEqual(Object.keys(out.shifts[0]).sort(), ["cargo", "cedula", "endTime", "fecha", "lunchStart", "observacion", "startTime", "tipo"]);
  assert.equal("published" in out, false);
});

test("publish body needs expectedVersion >= 1", () => {
  ok(publishBodySchema, { expectedVersion: 1 });
  ok(publishBodySchema, {
    expectedVersion: 1,
    snapshot: {
      recommendation: { runVersion: 7, dataAsOf: "2030-12-30", registers: null, slots: [{ fecha: "2031-01-06", franja: "08:00", final: 3 }] },
      suggested: { shifts: [{ cedula: "11111111", fecha: "2031-01-06", tipo: "TRABAJO", startTime: "07:00", endTime: "15:00", breakMinutes: 60, lunchStart: "11:00" }] },
    },
  });
  ok(publishBodySchema, { expectedVersion: 1, snapshot: { recommendation: null, suggested: null } });
  // A malformed snapshot never blocks publishing: it is dropped.
  for (const snapshot of [
    { recommendation: { slots: [{ fecha: "x", franja: "08:00", final: 3 }] }, suggested: null },
    { recommendation: { slots: [{ fecha: "2031-01-06", franja: "08:00", final: -1 }] }, suggested: null },
    { recommendation: null, suggested: { shifts: [{ cedula: "abc", fecha: "2031-01-06", tipo: "TRABAJO" }] } },
    "basura",
  ]) {
    const parsed = publishBodySchema.parse({ expectedVersion: 1, snapshot });
    assert.deepEqual(parsed, { expectedVersion: 1, snapshot: null }, JSON.stringify(snapshot));
  }



  bad(publishBodySchema, { expectedVersion: 0 });
  bad(publishBodySchema, {});
});

test("history limit defaults to 50 and caps at 200", () => {
  assert.equal(historyQuerySchema.parse({}).limit, 50);
  assert.equal(historyQuerySchema.parse({ limit: "200" }).limit, 200);
  bad(historyQuerySchema, { limit: "201" });
  bad(historyQuerySchema, { limit: "0" });
  bad(historyQuerySchema, { limit: "abc" });
});

test("expectedVersion null/undefined on save is read as 0; publish still requires >= 1", () => {
  assert.equal(saveBodySchema.parse(body({ expectedVersion: null })).expectedVersion, 0);
  const { expectedVersion, ...noVersion } = body();
  assert.equal(saveBodySchema.parse(noVersion).expectedVersion, 0);
  bad(publishBodySchema, {});
  bad(publishBodySchema, { expectedVersion: null });
});

test("NUL characters are rejected in free-text fields", () => {
  bad(saveBodySchema, body({ shifts: [shift({ cargo: "Caj\u0000ero" })] }));
  bad(saveBodySchema, body({ shifts: [shift({ observacion: "a\u0000" })] }));
  ok(saveBodySchema, body({ shifts: [shift({ cargo: "Cajero", observacion: "ok" })] }));
});
