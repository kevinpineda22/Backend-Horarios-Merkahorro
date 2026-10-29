import test from "node:test";
import assert from "node:assert/strict";
import { getEnv } from "../../src/config/env.js";

const base = { NODE_ENV: "test" };

test("trazabilidad settings are optional", () => {
  const env = getEnv({ ...base });
  assert.equal(env.TRAZABILIDAD_URL, undefined);
  assert.equal(env.TRAZABILIDAD_SERVICE_KEY, undefined);
});

test("trazabilidad settings are parsed when present", () => {
  const env = getEnv({
    ...base,
    TRAZABILIDAD_URL: "https://traz.example.com",
    TRAZABILIDAD_SERVICE_KEY: "secret",
  });
  assert.equal(env.TRAZABILIDAD_URL, "https://traz.example.com");
  assert.equal(env.TRAZABILIDAD_SERVICE_KEY, "secret");
});

test("an empty service key is rejected", () => {
  assert.throws(() => getEnv({ ...base, TRAZABILIDAD_SERVICE_KEY: "" }), /TRAZABILIDAD_SERVICE_KEY/);
});
