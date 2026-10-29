import test from "node:test";
import assert from "node:assert/strict";
import { createTrazabilidadClient } from "../../src/modules/empleados/trazabilidad.client.js";

const URL_BASE = "https://traz.example.com";
const KEY = "svc-key-123";
const ENDPOINT = `${URL_BASE}/api/trazabilidad/service/empleados-activos`;
const ROW = {
  cedula: "123456",
  nombre: "Ana",
  cargo: "Cajera",
  sede: "Centro",
  activo: true,
  restriccionOperativa: null,
};

const okResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function make(fetchImpl, over = {}) {
  return createTrazabilidadClient({ baseUrl: URL_BASE, serviceKey: KEY, fetchImpl, timeoutMs: 50, ...over });
}

async function assertUnavailable(promise) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, 503);
    assert.equal(err.code, "STAFF_SOURCE_UNAVAILABLE");
    assert.equal(err.expose, true);
    return true;
  });
}

test("calls the service endpoint with GET and only the x-api-key header", async () => {
  let call;
  const client = make(async (url, init) => {
    call = { url, init };
    return okResponse({ data: [ROW], total: 1, actualizado: "2026-01-01T00:00:00Z" });
  });
  const out = await client.fetchEmpleadosActivos();
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.init.method, "GET");
  assert.deepEqual(Object.keys(call.init.headers).map((h) => h.toLowerCase()).sort(), ["accept", "x-api-key"]);
  assert.equal(call.init.headers["x-api-key"], KEY);
  assert.deepEqual(out, { data: [ROW], total: 1, actualizado: "2026-01-01T00:00:00Z" });
});

test("never forwards the user token, even when one is offered", async () => {
  let init;
  const client = make(async (_url, i) => {
    init = i;
    return okResponse({ data: [] });
  });
  await client.fetchEmpleadosActivos({ authorization: "Bearer user-token" });
  const names = Object.keys(init.headers).map((h) => h.toLowerCase());
  assert.ok(!names.includes("authorization"));
  assert.ok(!JSON.stringify(init.headers).includes("user-token"));
});

test("trailing slash in base url is tolerated", async () => {
  let url;
  const client = make(
    async (u) => {
      url = u;
      return okResponse({ data: [] });
    },
    { baseUrl: `${URL_BASE}/` },
  );
  await client.fetchEmpleadosActivos();
  assert.equal(url, ENDPOINT);
});

test("multiple trailing slashes in base url are stripped", async () => {
  let url;
  const client = make(
    async (u) => {
      url = u;
      return okResponse({ data: [] });
    },
    { baseUrl: `${URL_BASE}///` },
  );
  await client.fetchEmpleadosActivos();
  assert.equal(url, ENDPOINT);
});

test("fetch is called with redirect: error and a redirect failure -> 503", async () => {
  let init;
  await make(async (_u, i) => {
    init = i;
    return okResponse({ data: [] });
  }).fetchEmpleadosActivos();
  assert.equal(init.redirect, "error");
  await assertUnavailable(
    make(async () => {
      throw new TypeError("fetch failed: redirect mode is set to error");
    }).fetchEmpleadosActivos(),
  );
});

test("non-2xx logs only the upstream status, never key, url or body", async () => {
  const lines = [];
  const logger = { warn: (...args) => lines.push(args) };
  const client = make(
    async () => ({ ok: false, status: 502, json: async () => ({ secret: KEY }), text: async () => KEY }),
    { logger },
  );
  await assertUnavailable(client.fetchEmpleadosActivos());
  assert.deepEqual(lines, [["[empleados] trazabilidad status", 502]]);
  const dump = JSON.stringify(lines);
  assert.ok(!dump.includes(KEY));
  assert.ok(!dump.includes(URL_BASE));
});

test("a genuine empty data array is returned, not an error", async () => {
  const client = make(async () => okResponse({ data: [], total: 0 }));
  const out = await client.fetchEmpleadosActivos();
  assert.deepEqual(out.data, []);
});

test("missing config -> 503 without calling fetch", async () => {
  let calls = 0;
  const f = async () => {
    calls += 1;
    return okResponse({ data: [] });
  };
  await assertUnavailable(make(f, { baseUrl: undefined }).fetchEmpleadosActivos());
  await assertUnavailable(make(f, { serviceKey: "" }).fetchEmpleadosActivos());
  await assertUnavailable(make(f, { baseUrl: "" }).fetchEmpleadosActivos());
  await assertUnavailable(make(f, { serviceKey: undefined }).fetchEmpleadosActivos());
  assert.equal(calls, 0);
});

test("non-2xx statuses -> 503 (401, 429, 500, 502, 503)", async () => {
  for (const status of [401, 429, 500, 502, 503]) {
    await assertUnavailable(make(async () => okResponse({ data: [] }, status)).fetchEmpleadosActivos());
  }
});

test("a response with ok=false is rejected even if the body parses", async () => {
  await assertUnavailable(
    make(async () => ({ ok: false, status: 302, json: async () => ({ data: [] }) })).fetchEmpleadosActivos(),
  );
});

test("network error -> 503", async () => {
  await assertUnavailable(
    make(async () => {
      throw new TypeError("fetch failed");
    }).fetchEmpleadosActivos(),
  );
});

test("timeout aborts the request -> 503", async () => {
  const client = make(
    (_url, init) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
    { timeoutMs: 20 },
  );
  await assertUnavailable(client.fetchEmpleadosActivos());
});

test("a signal is passed and the timer is cleared on success", async () => {
  let signal;
  const client = make(async (_u, init) => {
    signal = init.signal;
    return okResponse({ data: [] });
  });
  await client.fetchEmpleadosActivos();
  assert.ok(signal instanceof AbortSignal);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(signal.aborted, false);
});

test("malformed JSON -> 503", async () => {
  await assertUnavailable(
    make(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad");
      },
    })).fetchEmpleadosActivos(),
  );
});

test("malformed shapes -> 503 (never an empty list)", async () => {
  const bodies = [null, undefined, [], "x", 5, {}, { data: null }, { data: "x" }, { data: {} }, { total: 0 }];
  for (const body of bodies) {
    await assertUnavailable(make(async () => okResponse(body)).fetchEmpleadosActivos());
  }
});

test("rows that are not objects -> 503", async () => {
  await assertUnavailable(make(async () => okResponse({ data: [ROW, null] })).fetchEmpleadosActivos());
  await assertUnavailable(make(async () => okResponse({ data: [ROW, "x"] })).fetchEmpleadosActivos());
  await assertUnavailable(make(async () => okResponse({ data: [ROW, [1]] })).fetchEmpleadosActivos());
});

test("errors never leak the service key", async () => {
  const client = make(async () => {
    throw new Error(`boom ${KEY}`);
  });
  await assert.rejects(client.fetchEmpleadosActivos(), (err) => {
    assert.ok(!String(err.message).includes(KEY));
    return true;
  });
});

test("default timeout is 8000ms", async () => {
  const realSet = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...a) => {
    delays.push(ms);
    return realSet(fn, ms, ...a);
  };
  try {
    const client = createTrazabilidadClient({
      baseUrl: URL_BASE,
      serviceKey: KEY,
      fetchImpl: async () => okResponse({ data: [] }),
    });
    await client.fetchEmpleadosActivos();
  } finally {
    globalThis.setTimeout = realSet;
  }
  assert.ok(delays.includes(8000));
});
