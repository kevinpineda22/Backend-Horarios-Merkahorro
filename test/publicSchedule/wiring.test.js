import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");

// Default composition root: the public lookup is mounted WITHOUT authentication. A malformed body is rejected
// by validation (400), which proves the request got past the router without a token and without any network.
test("default wiring mounts /api/public/horarios/consulta without authentication", async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const res = await fetch(`${base}/public/horarios/consulta`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
      body: JSON.stringify({ cedula: "x" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "VALIDATION_ERROR");

    // The authenticated horarios router next to it still demands a token.
    const protectedRes = await fetch(`${base}/horarios/sedes/copacabana/weeks/2031-01-06/shifts`);
    assert.equal(protectedRes.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
