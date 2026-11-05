import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");

// Default composition root: /api/horarios is mounted behind authentication and needs no network
// to reject an anonymous call (Supabase is created lazily, never at import time).
test("default wiring mounts /api/horarios behind authentication", async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/horarios`;
    const week = "/sedes/copacabana/weeks/2031-01-06";
    for (const [method, path] of [["GET", `${week}/shifts`], ["PUT", `${week}/shifts`], ["POST", `${week}/publish`], ["GET", `${week}/history`]]) {
      const res = await fetch(base + path, { method });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
