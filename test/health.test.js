import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.NODE_ENV = "test";

const { createApp } = await import("../src/app.js");
const { createAuthenticate } = await import("../src/shared/http/authSupabase.js");
const { notFound } = await import("../src/shared/http/notFound.js");
const { errorHandler } = await import("../src/shared/http/errorHandler.js");

/** Starts an app on an ephemeral port; returns its base URL and a close fn. */
async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("GET /api/health -> 200 with status ok (no auth)", async () => {
  const { base, close } = await listen(createApp());
  try {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.service, "backend-horarios-merkahorro");
    assert.ok(body.version);
    assert.ok(!Number.isNaN(Date.parse(body.time)));
  } finally {
    await close();
  }
});

test("unknown route -> 404 JSON", async () => {
  const { base, close } = await listen(createApp());
  try {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "Ruta no encontrada");
  } finally {
    await close();
  }
});

test("protected route: no token -> 401, invalid -> 401, valid -> 200, provider down -> 503", async () => {
  const verifyToken = async (token) => {
    if (token === "good") return { id: "u1", email: "A@X.com" };
    if (token === "down") throw new Error("ECONNRESET");
    return null;
  };
  const app = express();
  app.get("/protected", createAuthenticate({ verifyToken }), (req, res) => res.json({ user: req.user }));
  app.use(notFound);
  app.use(errorHandler);

  const { base, close } = await listen(app);
  try {
    const none = await fetch(`${base}/protected`);
    assert.equal(none.status, 401);
    assert.equal((await none.json()).code, "AUTH_REQUIRED");

    const bad = await fetch(`${base}/protected`, { headers: { Authorization: "Bearer bad" } });
    assert.equal(bad.status, 401);
    assert.equal((await bad.json()).code, "AUTH_INVALID");

    const good = await fetch(`${base}/protected`, { headers: { Authorization: "Bearer good" } });
    assert.equal(good.status, 200);
    assert.deepEqual((await good.json()).user, { id: "u1", email: "a@x.com" });

    const down = await fetch(`${base}/protected`, { headers: { Authorization: "Bearer down" } });
    assert.equal(down.status, 503);
    assert.equal((await down.json()).code, "AUTH_UNAVAILABLE");
  } finally {
    await close();
  }
});

test("CORS: allowed origin is reflected, unknown origin -> 403", async () => {
  const { base, close } = await listen(createApp());
  try {
    const ok = await fetch(`${base}/api/health`, { headers: { Origin: "http://localhost:5173" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:5173");

    const denied = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
    assert.equal(denied.status, 403);
  } finally {
    await close();
  }
});
