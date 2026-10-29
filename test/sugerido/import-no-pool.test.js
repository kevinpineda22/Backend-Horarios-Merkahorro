import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// This file runs in its own process (node --test), so the patch below is in place before
// the application graph is first imported.
let constructed = 0;
pg.Pool = class FakePool {
  constructor() {
    constructed += 1;
  }
  on() {}
};

test("importing the app and the default routes does not construct a pg pool", async () => {
  process.env.NODE_ENV = "test";
  await import("../../src/app.js");
  await import("../../src/routes.js");
  assert.equal(constructed, 0);
});

test("serving an unauthenticated request does not construct a pg pool either", async () => {
  const { createApp } = await import("../../src/app.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sugerido/sedes`);
    assert.equal(res.status, 401);
    assert.equal(constructed, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
