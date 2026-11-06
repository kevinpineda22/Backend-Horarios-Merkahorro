import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SIESA_HEADERS,
  employeeNovelties,
  siesaTuples,
  variation,
} from "../../src/modules/horarios/domain/payrollRules.js";

// Golden parity against the OLD scheduler. The fixture is produced by
// scripts/payroll-parity/generate.mjs; this test never reads the old app folder.
const fx = JSON.parse(readFileSync(new URL("./fixtures/payrollParity.json", import.meta.url), "utf8"));

const pickWeek = (w) => ({
  weekStart: w.weekStart,
  workedHours: w.workedHours,
  extras: w.extras,
  nocturnas: w.nocturnas,
  dominicales: w.dominicales,
  festivos: w.festivos,
});

test("fixture records its source and has the expected shape", () => {
  assert.equal(fx.source.timezone, "America/Bogota");
  assert.deepEqual(fx.source.files, ["assets/js/labor-engine.js", "assets/js/reports.js", "assets/js/common.js"]);
  for (const hash of Object.values(fx.source.sha256)) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(fx.cases.length >= 80, `expected at least 80 cases, got ${fx.cases.length}`);
  assert.equal(fx.cases.filter((c) => c.name.startsWith("random week")).length, 60);
});

test("SIESA headers match the old export exactly", () => {
  assert.equal(fx.headers.length, 20);
  assert.deepEqual([...SIESA_HEADERS], fx.headers);
});

for (const c of fx.cases) {
  test(`parity: ${c.name}`, () => {
    const holidays = new Set(c.holidays);
    const results = c.employees.map((e) => ({
      employee: e,
      result: employeeNovelties(c.shifts.filter((s) => s.cedula === e.cedula), c.from, c.to, holidays),
    }));

    const rows = results.map(({ employee, result }) => ({
      cedula: employee.cedula,
      weeks: result.weeks.map(pickWeek),
      totals: {
        extras: result.totals.extras,
        nocturnas: result.totals.nocturnas,
        dominicales: result.totals.dominicales,
        festivos: result.totals.festivos,
      },
    }));
    assert.deepStrictEqual(rows, c.expected.rows);

    const tuples = siesaTuples(
      results.map(({ employee, result }) => ({ cedula: employee.cedula, siesaCode: employee.siesaCode, weeks: result.weeks })),
    );
    assert.deepStrictEqual(tuples, c.expected.siesa);
  });
}

for (const v of fx.variations) {
  test(`variation parity: ${v.current} vs ${v.previous}`, () => {
    assert.deepStrictEqual(variation(v.current, v.previous), v.expected);
  });
}
