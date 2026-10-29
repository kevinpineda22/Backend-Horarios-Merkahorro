import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { parseTtl } = await import("../../src/routes.js");

test("EMPLEADOS_CACHE_TTL_MS: digits are used; unset or invalid falls back to the default", () => {
  assert.equal(parseTtl("60000"), 60000);
  assert.equal(parseTtl("0"), 0);
  for (const raw of [undefined, "", "abc", "-5", "1.5", "10s"]) {
    assert.equal(parseTtl(raw), undefined, String(raw));
  }
});

// Default composition root: /api/empleados is mounted behind authentication and needs no
// network (neither Supabase nor trazabilidad) to reject an anonymous call.
test("default wiring mounts /api/empleados behind authentication", async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/empleados`;
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(`${base}?q=ana`)).status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
