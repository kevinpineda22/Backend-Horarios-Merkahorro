import test from "node:test";
import assert from "node:assert/strict";
import { mapEmpleados, filterForAccess } from "../../src/modules/empleados/domain/empleados.js";

const ALIASES = new Map([
  ["centro", "sede-1"],
  ["norte", "sede-2"],
]);
const KEYS = ["activo", "cargo", "cedula", "nombre", "restriccionOperativa", "sedeId", "unmappedSede"];

const row = (o = {}) => ({
  cedula: "00123456",
  nombre: "Ana Perez",
  cargo: "Cajera",
  sede: "Centro",
  activo: true,
  restriccionOperativa: null,
  ...o,
});

test("maps a row with exactly the allowed keys", () => {
  const { rows } = mapEmpleados([row()], ALIASES);
  assert.deepEqual(rows, [
    {
      cedula: "123456",
      nombre: "Ana Perez",
      cargo: "Cajera",
      sedeId: "sede-1",
      activo: true,
      unmappedSede: false,
      restriccionOperativa: null,
    },
  ]);
  assert.deepEqual(Object.keys(rows[0]).sort(), KEYS);
});

test("never emits restricciones or any extra key", () => {
  const { rows } = mapEmpleados(
    [row({ restricciones: "diagnostico", telefono: "1", email: "a@b.c", extra: 1 })],
    ALIASES,
  );
  assert.deepEqual(Object.keys(rows[0]).sort(), KEYS);
});

test("sede matches alias with accents, case and spaces", () => {
  const aliases = new Map([
    ["bodega n", "sede-9"],
    ["cafe", "sede-3"],
  ]);
  const { rows } = mapEmpleados(
    [row({ sede: "  BODEGA   Ñ " }), row({ cedula: "99999", sede: "Café" })],
    aliases,
  );
  assert.equal(rows[0].sedeId, "sede-9");
  assert.equal(rows[1].sedeId, "sede-3");
});

test("unmapped sede yields sedeId null and unmappedSede true", () => {
  const { rows } = mapEmpleados(
    [row({ sede: "Desconocida" }), row({ cedula: "99999", sede: null })],
    ALIASES,
  );
  for (const r of rows) {
    assert.equal(r.sedeId, null);
    assert.equal(r.unmappedSede, true);
  }
});

test("restriccionOperativa: string kept trimmed, empty or non-string becomes null", () => {
  const out = (v) => mapEmpleados([row({ restriccionOperativa: v })], ALIASES).rows[0].restriccionOperativa;
  assert.equal(out(" No levantar mas de 10 kg "), "No levantar mas de 10 kg");
  assert.equal(out(""), null);
  assert.equal(out("   "), null);
  assert.equal(out(undefined), null);
  assert.equal(out(null), null);
  assert.equal(out(5), null);
});

test("activo fails closed: only boolean true is active; others are excluded and counted", () => {
  const out = (v) => mapEmpleados([row({ activo: v })], ALIASES);
  assert.equal(out(true).rows[0].activo, true);
  for (const v of [undefined, null, "true", "false", false, 1, 0]) {
    const res = out(v);
    assert.deepEqual(res.rows, [], `activo=${JSON.stringify(v)}`);
    assert.equal(res.inactive, 1);
  }
});

test("alias lookup never reads the prototype chain (Map and plain object)", () => {
  for (const sede of ["Constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    for (const map of [ALIASES, { centro: "sede-1" }]) {
      const { rows } = mapEmpleados([row({ sede })], map);
      assert.equal(rows[0].sedeId, null, sede);
      assert.equal(rows[0].unmappedSede, true, sede);
    }
  }
});

test("conflicts counts tied duplicates that disagree on sedeId, first still wins", () => {
  const { rows, duplicates, conflicts } = mapEmpleados(
    [row({ nombre: "A", sede: "Centro" }), row({ nombre: "B", sede: "Norte" })],
    ALIASES,
  );
  assert.equal(rows[0].nombre, "A");
  assert.equal(duplicates, 1);
  assert.equal(conflicts, 1);
});

test("conflicts is 0 when tied duplicates agree or rank resolves the tie", () => {
  const same = mapEmpleados([row({ sede: "Centro" }), row({ sede: "Centro" })], ALIASES);
  assert.equal(same.conflicts, 0);
  const unmappedBoth = mapEmpleados([row({ sede: "X" }), row({ sede: "Y" })], ALIASES);
  assert.equal(unmappedBoth.conflicts, 0);
  const ranked = mapEmpleados([row({ sede: "Nope" }), row({ sede: "Norte" })], ALIASES);
  assert.equal(ranked.conflicts, 0);
  const keptMapped = mapEmpleados([row({ sede: "Norte" }), row({ sede: "Nope" })], ALIASES);
  assert.equal(keptMapped.rows[0].sedeId, "sede-2");
  assert.equal(keptMapped.conflicts, 0);
});

test("nombre and cargo are trimmed strings, missing become empty", () => {
  const { rows } = mapEmpleados([row({ nombre: "  Ana ", cargo: undefined })], ALIASES);
  assert.equal(rows[0].nombre, "Ana");
  assert.equal(rows[0].cargo, "");
});

test("drops invalid cedulas after normalization and counts them", () => {
  const input = [
    row({ cedula: "00001234" }), // 4 digits after normalization
    row({ cedula: "abc" }),
    row({ cedula: null }),
    row({ cedula: "1".repeat(16) }),
    row({ cedula: "12345" }), // lower boundary kept
    row({ cedula: "9".repeat(15) }), // upper boundary kept
  ];
  const { rows, dropped } = mapEmpleados(input, ALIASES);
  assert.equal(dropped, 4);
  assert.deepEqual(rows.map((r) => r.cedula), ["12345", "9".repeat(15)]);
});

test("de-duplicates by normalized cedula: inactive twin is excluded, not a duplicate", () => {
  const { rows, duplicates, inactive } = mapEmpleados(
    [row({ cedula: "00123456", activo: false, nombre: "Old" }), row({ cedula: "123456", nombre: "New" })],
    ALIASES,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nombre, "New");
  assert.equal(duplicates, 0);
  assert.equal(inactive, 1);
});

test("de-duplicates by normalized cedula: later active duplicate is counted", () => {
  const { rows, duplicates } = mapEmpleados(
    [row({ cedula: "00123456", nombre: "A" }), row({ cedula: "123456", nombre: "B" })],
    ALIASES,
  );
  assert.equal(rows.length, 1);
  assert.equal(duplicates, 1);
});

test("de-duplicates: mapped sede beats unmapped when activity ties", () => {
  const { rows } = mapEmpleados(
    [row({ nombre: "A", sede: "Nope" }), row({ nombre: "B", sede: "Norte" })],
    ALIASES,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nombre, "B");
});

test("de-duplicates: first occurrence wins on full tie, order preserved", () => {
  const { rows } = mapEmpleados(
    [
      row({ cedula: "11111", nombre: "X" }),
      row({ cedula: "22222", nombre: "Y" }),
      row({ cedula: "0011111", nombre: "Z" }),
    ],
    ALIASES,
  );
  assert.deepEqual(rows.map((r) => r.nombre), ["X", "Y"]);
});

test("non-array input and plain-object alias map are tolerated", () => {
  assert.deepEqual(mapEmpleados(undefined, ALIASES), { rows: [], dropped: 0, duplicates: 0, conflicts: 0, inactive: 0 });
  const { rows } = mapEmpleados([row()], { centro: "sede-1" });
  assert.equal(rows[0].sedeId, "sede-1");
});

const R = [
  { cedula: "11111", sedeId: "sede-1", unmappedSede: false },
  { cedula: "22222", sedeId: "sede-2", unmappedSede: false },
  { cedula: "33333", sedeId: null, unmappedSede: true },
];

test("filterForAccess: admin sees all incl. unmapped", () => {
  assert.equal(filterForAccess(R, { role: "admin", sedeIds: ["sede-1"] }).length, 3);
  assert.equal(filterForAccess(R, { role: "admin", sedeIds: null }).length, 3);
});

test("filterForAccess: sedeIds null sees all incl. unmapped", () => {
  assert.equal(filterForAccess(R, { role: "viewer", sedeIds: null }).length, 3);
  assert.equal(filterForAccess(R, { role: "viewer" }).length, 3);
});

test("filterForAccess: scoped sees only listed sedes, never unmapped", () => {
  const out = filterForAccess(R, { role: "planner", sedeIds: ["sede-1"] });
  assert.deepEqual(out.map((r) => r.cedula), ["11111"]);
});

test("filterForAccess: empty scope sees nothing; missing access sees nothing", () => {
  assert.deepEqual(filterForAccess(R, { role: "planner", sedeIds: [] }), []);
  assert.deepEqual(filterForAccess(R, null), []);
});

test("filterForAccess: scoped never gets unmapped even if sedeIds includes null", () => {
  const out = filterForAccess(R, { role: "planner", sedeIds: [null, "sede-2"] });
  assert.deepEqual(out.map((r) => r.cedula), ["22222"]);
});
