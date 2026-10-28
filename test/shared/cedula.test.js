import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCedula, isValidCedula } from "../../src/shared/cedula.js";

// Parity table with backend-trazabilidad normalizarCedula (services/empleadosSiesaService.js).
const PARITY = [
  ["0012345", "12345"],
  ["12345", "12345"],
  ["0000", "0000"],
  ["0", "0"],
  [" 1.020.304-050 ", "1020304050"],
  ["1.234.567-8 ", "12345678"],
  ["00123456", "123456"],
  ["00001234", "1234"],
  [null, ""],
  [undefined, ""],
  ["", ""],
  [1020304050, "1020304050"],
  [12345, "12345"],
  ["abc", ""],
  ["12a3-4 5", "12345"],
];

for (const [input, expected] of PARITY) {
  test(`normalizeCedula(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`, () => {
    assert.equal(normalizeCedula(input), expected);
  });
}

test("isValidCedula: 5-15 digits after normalization", () => {
  assert.equal(isValidCedula("12345"), true);
  assert.equal(isValidCedula("123456789012345"), true);
  assert.equal(isValidCedula("0012345"), true);
  assert.equal(isValidCedula("1234"), false);
  assert.equal(isValidCedula("1234567890123456"), false);
  assert.equal(isValidCedula(""), false);
  assert.equal(isValidCedula(null), false);
});

test("isValidCedula: R-h \"00001234\" normalizes to 4 digits and is invalid; \"0000\" invalid", () => {
  assert.equal(isValidCedula("00001234"), false);
  assert.equal(isValidCedula("0000"), false);
});
