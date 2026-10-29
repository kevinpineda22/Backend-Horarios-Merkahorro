import test from "node:test";
import assert from "node:assert/strict";

import { fakeSupabase } from "./helpers.js";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createSugeridoModule } = await import("../../src/modules/sugerido/sugerido.module.js");
const { createEmpleadosService } = await import("../../src/modules/empleados/empleados.service.js");
const { createLazyTrazabilidadClient } = await import("../../src/modules/empleados/trazabilidad.client.js");

const monday = (d) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
};
// The clock is real here, so the target week is derived from it.
const THIS_WEEK = monday(new Date());

const SEDE_ROW = { sede_id: "s1", nombre: "Centro", bodegas: ["B1"], activo: true };
const SETTINGS_ROW = {
  ordinary_weekly_hours: 42, overtime_weekly_hours: 12, daily_max_hours: 10, utilization: 0.85,
  max_working_days_per_week: 6, min_cashiers: 1, stale_after_days: 1,
  blocking_absence_types: ["Incapacidades", "Licencias", "Vacaciones", "Permisos", "Estudio", "Día de la Familia"],
  updated_by: null, updated_at: null,
};

// A pool whose database has no sales rows at all.
const emptyPool = {
  connect: async () => ({
    query: async (sql) => (/data_as_of/.test(String(sql)) ? { rows: [{ data_as_of: null }] } : { rows: [] }),
    release() {},
  }),
};

const ONE = { data: SEDE_ROW, error: null };
const LIST = { data: [SEDE_ROW], error: null };

// `sedes` scripts the sugerido_sedes results in call order: a run reads getSede twice (service and staff port).
async function withModule({ getPool, empleadosService, sedes = [ONE, ONE] }, fn) {
  const { client } = fakeSupabase({
    tables: {
      sugerido_sedes: [...sedes],
      sugerido_settings: { data: SETTINGS_ROW, error: null },
      novedades: { data: [], error: null },
    },
  });
  const router = createSugeridoModule({
    authenticate: createAuthenticate({ verifyToken: async (t) => (t === "t-admin" ? { id: "u-admin", email: "a@x.co" } : null) }),
    accessRepo: { findByUserId: async () => ({ role: "admin", sede_ids: null }) },
    client,
    empleadosService,
    getPool,
  });
  const server = createApp({ routes: createRoutes({ modules: { "/sugerido": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/sugerido`;
  const call = async (method, path) => {
    const res = await fetch(base + path, { method, headers: { authorization: "Bearer t-admin" } });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn(call);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const runPath = `/sedes/s1/weeks/${THIS_WEEK}/runs`;
const okStaff = () => {
  const calls = [];
  return { calls, async list(...args) { calls.push(args); return { data: [], total: 0 }; } };
};

test("the pg pool is created on the first sales query, never when the module is built or the sede list is read", async () => {
  let created = 0;
  const staff = okStaff();
  await withModule({ getPool: () => (created += 1, emptyPool), empleadosService: staff, sedes: [LIST, ONE, ONE] }, async (call) => {
    assert.equal(created, 0, "building the module must not touch the pool");
    assert.equal((await call("GET", "/sedes")).status, 200);
    assert.equal(created, 0, "listing sedes must not touch the pool");

    const run = await call("POST", runPath);
    assert.equal(run.status, 200); // no sales rows: zeros, nothing persisted
    assert.equal(run.json.data.flags.noHistory, true);
    assert.equal(created, 1, "the first sales query creates the pool");
  });
});

test("the staff port reads the SAME empleados service instance it was given (shared cache)", async () => {
  const staff = okStaff();
  await withModule({ getPool: () => emptyPool, empleadosService: staff }, async (call) => {
    assert.equal((await call("POST", runPath)).status, 200);
    assert.equal(staff.calls.length, 1);
    assert.deepEqual(staff.calls[0], [{ role: "admin", sedeIds: null }, { sede: "s1" }]);
  });
});

test("missing POSTGRES_* configuration is 503 SALES_DB_UNAVAILABLE at request time, not a crash", async () => {
  const getPool = () => {
    throw new Error("Missing database configuration: POSTGRES_HOST, POSTGRES_PASSWORD");
  };
  await withModule({ getPool, empleadosService: okStaff(), sedes: [ONE, ONE, LIST] }, async (call) => {
    const r = await call("POST", runPath);
    assert.deepEqual([r.status, r.json.code], [503, "SALES_DB_UNAVAILABLE"]);
    assert.doesNotMatch(JSON.stringify(r.json), /POSTGRES_/, "the missing variable names are not leaked");
    // Other endpoints keep working without the sales database.
    assert.equal((await call("GET", "/sedes")).status, 200);
  });
});

test("missing TRAZABILIDAD_* configuration is 503 STAFF_SOURCE_UNAVAILABLE and never an empty pool", async () => {
  const empleadosService = createEmpleadosService({
    client: createLazyTrazabilidadClient(() => ({})), // neither TRAZABILIDAD_URL nor TRAZABILIDAD_SERVICE_KEY
    aliasRepo: { loadAliasMap: async () => new Map() },
    logger: null,
  });
  await withModule({ getPool: () => emptyPool, empleadosService }, async (call) => {
    const r = await call("POST", runPath);
    assert.deepEqual([r.status, r.json.code], [503, "STAFF_SOURCE_UNAVAILABLE"]);
  });
});

test("the default app mounts /api/sugerido behind authentication (no Supabase, pg or trazabilidad needed to reject)", async () => {
  const { default: defaultRoutes } = await import("../../src/routes.js");
  const server = createApp({ routes: defaultRoutes }).listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/sugerido`;
    for (const [method, path] of [["GET", "/sedes"], ["GET", "/settings"], ["PUT", "/settings"], ["GET", `/sedes/s1/weeks/${THIS_WEEK}`], ["POST", `/sedes/s1/weeks/${THIS_WEEK}/runs`]]) {
      assert.equal((await fetch(base + path, { method })).status, 401, `${method} ${path}`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
