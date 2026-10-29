import test from "node:test";
import assert from "node:assert/strict";

import { createStaffPort, CASHIER_CARGOS } from "../../src/modules/sugerido/repositories/staff.port.js";
import { createHttpError } from "../../src/shared/http/HttpError.js";

const row = (cedula, cargo, sedeId = "s1", extra = {}) => ({
  cedula, nombre: "N", cargo, sedeId, activo: true, unmappedSede: sedeId === null, restriccionOperativa: null, ...extra,
});

function setup({ rows = [], listError, result, getSede } = {}) {
  const calls = [];
  const empleados = {
    async list(access, filters) {
      calls.push({ access, filters });
      if (listError) throw listError;
      return result ?? { data: rows, total: rows.length, actualizado: "2026-10-28T10:00:00Z" };
    },
  };
  const sedeCalls = [];
  const sedeRepo = {
    async getSede(id) {
      sedeCalls.push(id);
      if (getSede) return getSede(id);
      return { sedeId: id, nombre: "Sede", bodegas: ["B1"], activo: true };
    },
  };
  return { port: createStaffPort(empleados, sedeRepo), calls, sedeCalls };
}

test("returns active cashiers of the sede with normalized, unique cedulas", async () => {
  const { port } = setup({
    rows: [
      row("0012345", "CAJERA"),
      row("12345", "Cajero"), // same person after normalization
      row("1.234.567-8", "CAJERO - SURTIDOR"),
      row("55555", "Auxiliar de caja"),
      row("66666", "Jefe de cajas"),
      row("77777", "Administrador"),
      row("88888", "CAJERA", "s2"),
      row("99999", "Cajéro", null, { unmappedSede: true }),
      row("", "Cajera"),
      row(null, "Cajera"),
      row("11111", "Cajera", "s1", { activo: false }),
    ],
  });
  assert.deepEqual(await port.getCashierPool("s1"), [{ cedula: "12345" }, { cedula: "12345678" }]);
});

test("cargo matching is an exact allowlist (case, accent and spacing insensitive)", async () => {
  assert.deepEqual([...CASHIER_CARGOS], ["cajera", "cajero", "cajero - surtidor"]);
  const included = ["CAJERA", "Cajero", "Cajéra", "CAJERO - SURTIDOR", "cajero-surtidor", "CAJERO  -  SURTIDOR", "  cajero -surtidor "];
  const inc = setup({ rows: included.map((c, i) => row(String(10000 + i), c)) });
  assert.equal((await inc.port.getCashierPool("s1")).length, included.length);
  const excluded = ["CAJERO PAC", "JEFE DE CAJEROS", "AUXILIAR DE CAJA", "CAJERA PRINCIPAL", "Cajera de apoyo", "CAJERO(A)", "CAJERO - ", "CAJERO - SURTIDOR 2", "", null, undefined, "Cajas"];
  const none = setup({ rows: excluded.map((c, i) => row(String(20000 + i), c)) });
  assert.deepEqual(await none.port.getCashierPool("s1"), []);
});

test("reads with an internal all-sedes access and never forwards user credentials", async () => {
  const { port, calls } = setup();
  await port.getCashierPool("s1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].access.role, "admin");
  assert.equal(calls[0].access.sedeIds, null);
  assert.ok(Object.isFrozen(calls[0].access));
  assert.deepEqual(calls[0].filters, { sede: "s1" });
});

test("a genuinely empty pool is valid", async () => {
  const { port } = setup({ rows: [] });
  assert.deepEqual(await port.getCashierPool("s1"), []);
});

test("STAFF_SOURCE_UNAVAILABLE propagates unchanged, never an empty pool", async () => {
  const err = createHttpError(503, "down", "STAFF_SOURCE_UNAVAILABLE");
  const { port } = setup({ listError: err });
  await assert.rejects(port.getCashierPool("s1"), (e) => e === err);
  const other = setup({ listError: new TypeError("boom") });
  await assert.rejects(other.port.getCashierPool("s1"), TypeError);
});

test("a malformed directory result fails with 503 STAFF_SOURCE_UNAVAILABLE", async () => {
  for (const result of [{ actualizado: "x" }, {}, { data: null }, { data: "x" }]) {
    const { port } = setup({ result });
    await assert.rejects(
      port.getCashierPool("s1"),
      (e) => e.statusCode === 503 && e.code === "STAFF_SOURCE_UNAVAILABLE" && e.expose,
    );
  }
});

test("unmapped sede -> SEDE_NOT_MAPPED before the directory is read", async () => {
  const notMapped = createHttpError(404, "no", "SEDE_NOT_MAPPED");
  const { port, calls } = setup({
    getSede: () => {
      throw notMapped;
    },
  });
  await assert.rejects(port.getCashierPool("zzz"), (e) => e === notMapped);
  assert.equal(calls.length, 0);
});

test("missing or blank sedeId -> 404 SEDE_NOT_MAPPED without touching any source", async () => {
  const { port, calls, sedeCalls } = setup();
  for (const bad of [undefined, null, "", "   "]) {
    await assert.rejects(
      port.getCashierPool(bad),
      (e) => e.statusCode === 404 && e.code === "SEDE_NOT_MAPPED" && e.expose,
    );
  }
  assert.equal(calls.length, 0);
  assert.equal(sedeCalls.length, 0);
});

test("createStaffPort requires both collaborators", () => {
  assert.throws(() => createStaffPort(undefined, { getSede() {} }));
  assert.throws(() => createStaffPort({ list() {} }, undefined));
});
