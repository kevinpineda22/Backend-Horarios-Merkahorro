import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createPublicScheduleRouter } = await import("../../src/modules/publicSchedule/publicSchedule.routes.js");
const { createPublicScheduleService } = await import("../../src/modules/publicSchedule/publicSchedule.service.js");
const { createRateLimiter } = await import("../../src/shared/http/rateLimit.js");
const { NOW, fakes, shiftRow } = await import("./helpers.js");

async function withApp(fn, { limiter = createRateLimiter(), ...opts } = {}) {
  const f = fakes({ shifts: [shiftRow()], ...opts });
  const service = createPublicScheduleService({ ...f, now: () => NOW });
  const router = createPublicScheduleRouter({ service, rateLimit: limiter });
  const server = createApp({ routes: createRoutes({ modules: { "/public/horarios": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/api/public/horarios/consulta`;
  const post = async (body, headers = {}) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ post, calls: f.calls, url });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("200 without any Authorization header; normalizes the cedula and sends no-store", () =>
  withApp(async ({ post, calls }) => {
    const res = await post({ cedula: " 0.123.456 " });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.json.data.empleado.nombre, "Ana Perez");
    assert.equal(res.json.data.semanas.length, 1);
    assert.deepEqual(calls[0], ["findActiveByCedula", "123456"]);
    assert.ok(!JSON.stringify(res.json).includes("123456"));
  }));

test("400 VALIDATION_ERROR for a missing, non-string or malformed cedula", () =>
  withApp(async ({ post, calls }) => {
    for (const body of [{}, { cedula: 123456 }, { cedula: "abc" }, { cedula: "1234" }, { cedula: "9".repeat(31) }, { cedula: "" }]) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json.code, "VALIDATION_ERROR");
      assert.equal(res.json.ok, false);
    }
    assert.equal(calls.length, 0);
  }));

test("404 with the generic shape for an unknown or inactive employee", () =>
  withApp(
    async ({ post }) => {
      const res = await post({ cedula: "999999" });
      assert.equal(res.status, 404);
      assert.deepEqual(res.json, { ok: false, error: "No encontramos horarios para esa cédula.", code: "NOT_FOUND" });
    },
    { employee: null },
  ));

test("429 with Spanish message and Retry-After after the per-IP limit; other IPs are unaffected", () =>
  withApp(
    async ({ post }) => {
      for (let i = 0; i < 3; i++) assert.equal((await post({ cedula: "123456" }, { "x-forwarded-for": "1.1.1.1" })).status, 200);
      const res = await post({ cedula: "123456" }, { "x-forwarded-for": "1.1.1.1" });
      assert.equal(res.status, 429);
      assert.equal(res.json.code, "RATE_LIMITED");
      assert.match(res.json.error, /Demasiados intentos/);
      assert.ok(Number(res.headers.get("retry-after")) >= 1);
      assert.equal((await post({ cedula: "123456" }, { "x-forwarded-for": "2.2.2.2" })).status, 200);
    },
    { limiter: createRateLimiter({ max: 3 }) },
  ));

test("invalid requests also consume the rate limit", () =>
  withApp(
    async ({ post }) => {
      assert.equal((await post({ cedula: "x" })).status, 400);
      assert.equal((await post({ cedula: "x" })).status, 400);
      assert.equal((await post({ cedula: "123456" })).status, 429);
    },
    { limiter: createRateLimiter({ max: 2 }) },
  ));

test("CORS: allowed origin gets the header; unknown origin is rejected", () =>
  withApp(async ({ post }) => {
    const ok = await post({ cedula: "123456" }, { origin: "https://merkahorro.com" });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://merkahorro.com");
    const bad = await post({ cedula: "123456" }, { origin: "https://evil.example" });
    assert.equal(bad.status, 403);
  }));
