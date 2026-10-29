import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");

// Default composition root: /api/accesos is mounted behind authentication and needs no network
// to reject an anonymous call (Supabase is created lazily, never at import time).
test("default wiring mounts /api/accesos behind authentication", async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/accesos`;
    for (const [method, path] of [["GET", ""], ["POST", ""], ["GET", "/usuarios?q=ab"], ["POST", "/11111111-1111-4111-8111-111111111111/revocar"]]) {
      const res = await fetch(base + path, { method });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
