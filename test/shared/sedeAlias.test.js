import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSedeAlias } from "../../src/shared/sedeAlias.js";

// Parity with SQL: lower(unaccent(btrim(regexp_replace(alias, '\s+', ' ', 'g')))).
const CASES = [
  ["SUPER MERKAHORRO CENTRO", "super merkahorro centro"],
  ["  Super   Merkahorro\tCentro \n", "super merkahorro centro"],
  ["Mercahorro Peñón", "mercahorro penon"],
  ["ÁÉÍÓÚ áéíóú ÜÑ", "aeiou aeiou un"],
  ["", ""],
  ["   ", ""],
];

for (const [input, expected] of CASES) {
  test(`normalizeSedeAlias(${JSON.stringify(input)})`, () => {
    assert.equal(normalizeSedeAlias(input), expected);
  });
}

test("decomposed (NFD) input normalizes like composed (NFC)", () => {
  assert.equal(normalizeSedeAlias("Peñón"), normalizeSedeAlias("Peñón"));
});

test("null and undefined become an empty string", () => {
  assert.equal(normalizeSedeAlias(null), "");
  assert.equal(normalizeSedeAlias(undefined), "");
});
