import test from "node:test";
import assert from "node:assert/strict";

import { createServiceKeyAuth } from "../../src/shared/http/serviceKey.js";

const run = (mw, headers = {}) =>
  new Promise((resolve) => {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    mw({ headers: lower, get: (n) => lower[n.toLowerCase()] }, {}, (err) => resolve(err ?? null));
  });

const auth = (key) => createServiceKeyAuth({ getKey: () => key });

test("accepts the configured key", async () => {
  assert.equal(await run(auth("s3cret-key"), { "x-service-key": "s3cret-key" }), null);
});

test("fails closed with 503 SERVICE_KEY_NOT_CONFIGURED when the key is unset or empty", async () => {
  for (const key of [undefined, "", "   "]) {
    const err = await run(auth(key), { "x-service-key": "anything" });
    assert.deepEqual([err.statusCode, err.code], [503, "SERVICE_KEY_NOT_CONFIGURED"], String(key));
  }
});

test("rejects missing, wrong and different-length keys with 401 INVALID_SERVICE_KEY", async () => {
  for (const headers of [{}, { "x-service-key": "" }, { "x-service-key": "wrong-key!!" }, { "x-service-key": "s3cret-key-and-more" }, { "x-service-key": "s3" }]) {
    const err = await run(auth("s3cret-key"), headers);
    assert.deepEqual([err.statusCode, err.code], [401, "INVALID_SERVICE_KEY"], JSON.stringify(headers));
  }
});

test("a repeated header (array) is rejected, never coerced", async () => {
  const err = await run(auth("s3cret-key"), { "x-service-key": ["s3cret-key", "s3cret-key"] });
  assert.equal(err.code, "INVALID_SERVICE_KEY");
});

test("error messages never contain the configured or the supplied key", async () => {
  const err = await run(auth("s3cret-key"), { "x-service-key": "supplied-guess" });
  assert.doesNotMatch(err.message, /s3cret-key|supplied-guess/);
});

test("reads the key lazily on each request (rotation without restart)", async () => {
  let key = "old-key";
  const mw = createServiceKeyAuth({ getKey: () => key });
  assert.equal(await run(mw, { "x-service-key": "old-key" }), null);
  key = "new-key";
  assert.equal((await run(mw, { "x-service-key": "old-key" })).code, "INVALID_SERVICE_KEY");
});
