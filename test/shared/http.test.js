import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { z } from "zod";

process.env.NODE_ENV = "test";

const { asyncHandler } = await import("../../src/shared/http/asyncHandler.js");
const { validate } = await import("../../src/shared/http/validate.js");
const { errorHandler } = await import("../../src/shared/http/errorHandler.js");
const { createHttpError } = await import("../../src/shared/http/HttpError.js");
const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function build(setup) {
  const app = express();
  app.use(express.json());
  setup(app);
  app.use(errorHandler);
  return app;
}

test("asyncHandler forwards rejected promises to the error handler", async () => {
  const app = build((a) =>
    a.get("/boom", asyncHandler(async () => {
      throw createHttpError(418, "teapot", "TEAPOT");
    })),
  );
  const { base, close } = await listen(app);
  try {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 418);
    assert.equal((await res.json()).code, "TEAPOT");
  } finally {
    await close();
  }
});

test("validate: invalid body -> 400 VALIDATION_ERROR with details; valid body is parsed", async () => {
  const schema = z.object({ n: z.coerce.number().int().min(0) });
  const app = build((a) =>
    a.post("/v", validate({ body: schema }), (req, res) => res.json({ body: req.body })),
  );
  const { base, close } = await listen(app);
  const post = (body) =>
    fetch(`${base}/v`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const bad = await post({ n: -1 });
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.code, "VALIDATION_ERROR");
    assert.ok(Array.isArray(badBody.details) && badBody.details.length === 1);
    assert.equal(badBody.details[0].path, "body.n");

    const good = await post({ n: "3" });
    assert.equal(good.status, 200);
    assert.deepEqual((await good.json()).body, { n: 3 });
  } finally {
    await close();
  }
});

test("errorHandler: includes details when present; pg 57014 -> 504 SALES_DB_TIMEOUT", async () => {
  const app = build((a) => {
    a.get("/d", (_req, _res, next) => {
      const err = createHttpError(400, "bad", "X");
      err.details = [{ path: "a", message: "m" }];
      next(err);
    });
    a.get("/t", (_req, _res, next) => next(Object.assign(new Error("canceling statement"), { code: "57014" })));
  });
  const { base, close } = await listen(app);
  try {
    assert.deepEqual((await (await fetch(`${base}/d`)).json()).details, [{ path: "a", message: "m" }]);
    const t = await fetch(`${base}/t`);
    assert.equal(t.status, 504);
    const tb = await t.json();
    assert.equal(tb.code, "SALES_DB_TIMEOUT");
    assert.equal(tb.error.includes("canceling"), false);
  } finally {
    await close();
  }
});

test("createRoutes/createApp accept injected module routers", async () => {
  const { Router } = await import("express");
  const extra = Router();
  extra.get("/", (_req, res) => res.json({ injected: true }));
  const routes = createRoutes({ modules: { "/extra": extra } });
  assert.equal(typeof routes, "function");
  const { base, close } = await listen(createApp({ routes }));
  try {
    assert.equal((await (await fetch(`${base}/api/extra`)).json()).injected, true);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  } finally {
    await close();
  }
});

test("errorHandler: never leaks non-exposed codes on 500; 57014 still maps to 504", async () => {
  const app = build((a) => {
    a.get("/pg", (_req, _res, next) => next(Object.assign(new Error("duplicate key"), { code: "23505" })));
    a.get("/t", (_req, _res, next) => next(Object.assign(new Error("canceling"), { code: "57014" })));
  });
  const { base, close } = await listen(app);
  try {
    const res = await fetch(`${base}/pg`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal("code" in body, false);
    assert.equal(body.error.includes("duplicate"), false);
    const t = await fetch(`${base}/t`);
    assert.equal(t.status, 504);
    assert.equal((await t.json()).code, "SALES_DB_TIMEOUT");
  } finally {
    await close();
  }
});

test("validate({query}) coerces query params through an app", async () => {
  const schema = z.object({ n: z.coerce.number().int(), flag: z.enum(["a", "b"]).default("a") });
  const app = build((a) => a.get("/q", validate({ query: schema }), (req, res) => res.json({ query: req.query })));
  const { base, close } = await listen(app);
  try {
    const ok = await fetch(`${base}/q?n=5`);
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).query, { n: 5, flag: "a" });
    const bad = await fetch(`${base}/q?n=abc`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).details[0].path, "query.n");
  } finally {
    await close();
  }
});

test("createApp: malformed JSON -> 400 and oversized body -> 413", async () => {
  const { base, close } = await listen(createApp());
  const post = (body) => fetch(`${base}/api/health`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  try {
    const malformed = await post("{not json");
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).ok, false);
    const big = await post(JSON.stringify({ x: "a".repeat(3 * 1024 * 1024) }));
    assert.equal(big.status, 413);
    assert.equal((await big.json()).ok, false);
  } finally {
    await close();
  }
});
