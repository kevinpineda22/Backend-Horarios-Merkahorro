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
  bad(saveBodySchema, { cedulas: ["11111111"], shifts: [] });
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
