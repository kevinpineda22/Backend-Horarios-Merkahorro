import test from "node:test";
import assert from "node:assert/strict";
import { coverageByKey, onlyPeople } from "../../src/modules/sugerido/domain/shiftCoverage.js";
import { createPublishedShiftsPort } from "../../src/modules/sugerido/repositories/publishedShifts.port.js";

const D = "2026-11-09";
const slots = (map) => [...map.keys()].map((k) => k.split("|")[1]).sort();

test("counts the people present per 15 minutes, without the lunch, in both row shapes", () => {
  const map = coverageByKey([
    { cedula: "1", fecha: D, tipo: "TRABAJO", startTime: "08:00", endTime: "10:00", breakMinutes: 0, lunchStart: null },
    { cedula: "2", fecha: D, tipo: "TRABAJO", start_time: "08:00:00", end_time: "16:00:00", break_minutes: 60, lunch_start: "12:00:00" },
    { cedula: "3", fecha: D, tipo: "DESCANSO", startTime: null, endTime: null },
  ]);
  assert.equal(map.get(`${D}|08:00`), 2);
  assert.equal(map.get(`${D}|10:00`), 1);
  for (const f of ["12:00", "12:15", "12:30", "12:45"]) assert.equal(map.has(`${D}|${f}`), false);
  assert.equal(map.get(`${D}|13:00`), 1);
  assert.equal(slots(map).at(-1), "15:45");
  assert.equal(map.size, 8 * 4 - 4);
});

test("a missing lunch falls 4 h after the start; a missing break follows the 6 h rule; midnight ends the day", () => {
  const long = coverageByKey([{ cedula: "1", fecha: D, tipo: "TRABAJO", startTime: "07:00", endTime: "15:00" }]);
  assert.equal(long.has(`${D}|11:00`), false);
  assert.equal(long.size, 28);
  assert.equal(coverageByKey([{ cedula: "1", fecha: D, tipo: "TRABAJO", startTime: "07:00", endTime: "12:00" }]).size, 20);
  assert.equal(slots(coverageByKey([{ cedula: "1", fecha: D, tipo: "TRABAJO", startTime: "22:00", endTime: "02:00", breakMinutes: 0 }])).at(-1), "23:45");
});

test("onlyPeople keeps the team, or everybody without a list", () => {
  const rows = [{ cedula: "1" }, { cedula: 2 }];
  assert.deepEqual(onlyPeople(rows, ["2"]), [{ cedula: 2 }]);
  assert.equal(onlyPeople(rows, null).length, 2);
});

test("the port reads only a published cashier schedule", async () => {
  const repo = (state) => ({
    async findSchedule(...args) {
      assert.deepEqual(args, ["s1", D, "CAJEROS"]);
      return state ? { id: 7, state } : null;
    },
    async listShifts(id) { return [{ id }]; },
  });
  assert.deepEqual(await createPublishedShiftsPort(repo("PUBLICADO")).listPublishedCashierShifts("s1", D), [{ id: 7 }]);
  assert.equal(await createPublishedShiftsPort(repo("BORRADOR")).listPublishedCashierShifts("s1", D), null);
  assert.equal(await createPublishedShiftsPort(repo(null)).listPublishedCashierShifts("s1", D), null);
});
