import test from "node:test";
import assert from "node:assert/strict";
import { ADJ, FIR, HIS, SOP, createFakeRepo, createFakeStorage, ID_A, ID_B, ID_C } from "./helpers.js";

process.env.NODE_ENV = "test";

const { createApp } = await import("../../src/app.js");
const { createRoutes } = await import("../../src/routes.js");
const { createAuthenticate } = await import("../../src/shared/http/authSupabase.js");
const { createNovedadesRouter } = await import("../../src/modules/novedades/novedades.routes.js");
const { createNovedadesService } = await import("../../src/modules/novedades/novedades.service.js");

// token -> user; user -> access row (sugerido_access shape). Expectations come from spec R7.7.
const USERS = { "t-admin": "u-admin", "t-planner": "u-planner", "t-planner-all": "u-planner-all", "t-viewer": "u-viewer", "t-norole": "u-norole" };
const ACCESS = {
  "u-admin": { role: "admin", sede_ids: null },
  "u-planner": { role: "planner", sede_ids: ["s1"] },
  "u-planner-all": { role: "planner", sede_ids: null },
  "u-viewer": { role: "viewer", sede_ids: ["s1"] },
};

const row = (o) => ({ cedula: "1020304050", tipo: "Permisos", fecha_inicio: "2026-11-10", fecha_fin: "2026-11-20", sede_id: "s1", ...o });
const body = { cedula: "1020304050", tipo: "Vacaciones", fechaInicio: "2026-11-03", fechaFin: "2026-11-14", sedeId: "s1" };

async function start(seed = [], files = [ADJ, FIR, HIS, SOP]) {
  const repo = createFakeRepo(seed);
  const storage = createFakeStorage(files);
  const router = createNovedadesRouter({
    authenticate: createAuthenticate({
      verifyToken: async (t) => (USERS[t] ? { id: USERS[t], email: `${USERS[t]}@x.co` } : null),
    }),
    accessRepo: { findByUserId: async (id) => ACCESS[id] ?? null },
    service: createNovedadesService({
      repo,
      storage,
      profilesRepo: { findById: async (id) => (id === "u-planner" ? { nombre: "Paula Planner" } : null) },
    }),
  });
  const server = createApp({ routes: createRoutes({ modules: { "/novedades": router } }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/novedades`;
  const call = async (method, path, token, json) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { repo, storage, call, close: () => new Promise((r) => server.close(r)) };
}

async function withApp(seed, fn) {
  const app = await start(seed);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test("authentication: 401 without token or with an invalid one; 403 for a user without access row", () =>
  withApp([], async ({ call }) => {
    for (const [m, p, b] of [["GET", "/"], ["GET", `/${ID_A}`], ["POST", "/", body], ["PATCH", `/${ID_A}`, { tipo: "Permisos académicos" }], ["POST", `/${ID_A}/anular`, { motivo: "m" }]]) {
      assert.equal((await call(m, p, null, b)).status, 401, `${m} ${p}`);
      assert.equal((await call(m, p, "bogus", b)).status, 401, `${m} ${p} bogus`);
      const r = await call(m, p, "t-norole", b);
      assert.equal(r.status, 403, `${m} ${p} norole`);
      assert.equal(r.json.code, "FORBIDDEN_ROLE");
    }
  }));

test("viewer: read-only; writes are 403 even when the body is invalid (role check first)", () =>
  withApp([row({ id: ID_A })], async ({ call, repo }) => {
    assert.equal((await call("GET", "/", "t-viewer")).status, 200);
    assert.equal((await call("GET", `/${ID_A}`, "t-viewer")).status, 200);
    for (const [m, p, b] of [["POST", "/", body], ["POST", "/", {}], ["PATCH", `/${ID_A}`, { tipo: "Permisos académicos" }], ["POST", `/${ID_A}/anular`, { motivo: "m" }]]) {
      const r = await call(m, p, "t-viewer", b);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.json.code, "FORBIDDEN_ROLE");
    }
    assert.equal(repo.calls.insert.length + repo.calls.update.length, 0);
  }));

test("viewer sede scoping: other sede 403, null-sede rows invisible/forbidden", () =>
  withApp([row({ id: ID_A, sede_id: "s2" }), row({ id: ID_B, sede_id: null }), row({ id: ID_C, sede_id: "s1" })], async ({ call }) => {
    assert.equal((await call("GET", "/?sede=s2", "t-viewer")).json.code, "FORBIDDEN_SEDE");
    assert.equal((await call("GET", `/${ID_A}`, "t-viewer")).status, 403);
    assert.equal((await call("GET", `/${ID_B}`, "t-viewer")).status, 403);
    assert.deepEqual((await call("GET", "/", "t-viewer")).json.data.map((d) => d.id), [ID_C]);
    // an all-sedes planner is still not admin: null-sede rows stay hidden
    assert.equal((await call("GET", `/${ID_B}`, "t-planner-all")).status, 403);
    assert.deepEqual((await call("GET", "/", "t-planner-all")).json.data.map((d) => d.id).sort(), [ID_A, ID_C].sort());
    // admin sees everything
    assert.equal((await call("GET", "/", "t-admin")).json.data.length, 3);
    assert.equal((await call("GET", `/${ID_B}`, "t-admin")).status, 200);
  }));

test("planner: writes inside own sede, 403 elsewhere or without sedeId", () =>
  withApp([row({ id: ID_A, sede_id: "s1" }), row({ id: ID_B, sede_id: "s2", cedula: "555555" }), row({ id: ID_C, sede_id: null, cedula: "666666" })], async ({ call, repo }) => {
    const ok = await call("POST", "/", "t-planner", body);
    assert.equal(ok.status, 201);
    assert.equal(ok.json.data.sedeId, "s1");
    const before = repo.rows.length;
    assert.equal((await call("POST", "/", "t-planner", { ...body, sedeId: "s2" })).json.code, "FORBIDDEN_SEDE");
    assert.equal((await call("POST", "/", "t-planner", { ...body, sedeId: undefined })).json.code, "FORBIDDEN_SEDE");
    assert.equal((await call("POST", "/", "t-planner-all", { ...body, sedeId: undefined })).json.code, "FORBIDDEN_SEDE");
    assert.equal(repo.rows.length, before);

    assert.equal((await call("PATCH", `/${ID_A}`, "t-planner", { observacion: "ok" })).status, 200);
    for (const id of [ID_B, ID_C]) {
      assert.equal((await call("PATCH", `/${id}`, "t-planner", { observacion: "x" })).status, 403);
      assert.equal((await call("POST", `/${id}/anular`, "t-planner", { motivo: "m" })).status, 403);
    }
    assert.equal((await call("POST", `/${ID_A}/anular`, "t-planner", { motivo: "dup" })).status, 200);
  }));

test("admin may create and manage null-sede rows", () =>
  withApp([], async ({ call }) => {
    const r = await call("POST", "/", "t-admin", { ...body, sedeId: undefined });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.sedeId, null);
    assert.equal((await call("PATCH", `/${r.json.data.id}`, "t-admin", { observacion: "x" })).status, 200);
  }));

test("create: audit from the token, body spoof ignored, response shape and overlap warning", () =>
  withApp([row({ id: ID_A, fecha_inicio: "2026-11-14", fecha_fin: "2026-11-16" })], async ({ call, repo }) => {
    const r = await call("POST", "/", "t-planner", { ...body, cedula: "1.020.304.050", created_by: "other", anulada: true });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.createdBy, "u-planner");
    assert.equal(r.json.data.anulada, false);
    assert.equal(r.json.data.cedula, "1020304050");
    assert.deepEqual(r.json.warnings, [{ code: "OVERLAP", ids: [ID_A] }]);
    assert.equal(repo.calls.insert[0].created_by, "u-planner");
  }));

test("validation: 400 VALIDATION_ERROR with details and nothing persisted", () =>
  withApp([row({ id: ID_A })], async ({ call, repo }) => {
    const bads = [
      { ...body, fechaFin: "2026-11-02" },
      { ...body, tipo: "Sabático" },
      { ...body, cedula: "12" },
      { ...body, fechaInicio: "2026-02-30" },
      { tipo: "Vacaciones" },
    ];
    for (const b of bads) {
      const r = await call("POST", "/", "t-admin", b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.json.code, "VALIDATION_ERROR");
      assert.ok(r.json.details.length > 0);
    }
    assert.equal(repo.calls.insert.length, 0);

    assert.equal((await call("PATCH", `/${ID_A}`, "t-admin", {})).status, 400);
    assert.equal((await call("PATCH", "/not-a-uuid", "t-admin", { tipo: "Permisos académicos" })).status, 400);
    assert.equal((await call("PATCH", `/${ID_A}`, "t-admin", { fechaFin: "2026-11-01" })).status, 400); // merged range
    assert.equal((await call("POST", `/${ID_A}/anular`, "t-admin", {})).status, 400);
    assert.equal((await call("POST", `/${ID_A}/anular`, "t-admin", { motivo: "x".repeat(501) })).status, 400);
    assert.equal((await call("GET", "/?desde=2026-11-30&hasta=2026-11-01", "t-admin")).status, 400);
    assert.equal((await call("GET", "/not-a-uuid", "t-admin")).status, 400);
    assert.equal(repo.calls.update.length, 0);
    assert.equal(repo.rows[0].anulada, false);
  }));

test("404 for unknown ids; 409 NOVEDAD_CANCELLED on PATCH/anular of a cancelled row", () =>
  withApp([row({ id: ID_A, anulada: true, anulada_at: "t" })], async ({ call, repo }) => {
    assert.equal((await call("GET", `/${ID_B}`, "t-admin")).json.code, "NOVEDAD_NOT_FOUND");
    assert.equal((await call("PATCH", `/${ID_B}`, "t-admin", { tipo: "Permisos académicos" })).status, 404);
    assert.equal((await call("POST", `/${ID_B}/anular`, "t-admin", { motivo: "m" })).status, 404);
    const p = await call("PATCH", `/${ID_A}`, "t-admin", { tipo: "Permisos académicos" });
    assert.equal(p.status, 409);
    assert.equal(p.json.code, "NOVEDAD_CANCELLED");
    assert.equal((await call("POST", `/${ID_A}/anular`, "t-admin", { motivo: "m" })).status, 409);
    assert.equal(repo.calls.update.length, 0);
    assert.equal((await call("GET", `/${ID_A}`, "t-admin")).status, 200); // cancelled rows stay readable
  }));

test("anular: soft cancel with audit; row leaves the default list but stays retrievable", () =>
  withApp([row({ id: ID_A })], async ({ call, repo }) => {
    const r = await call("POST", `/${ID_A}/anular`, "t-admin", { motivo: "digitada dos veces" });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.anulada, true);
    assert.equal(r.json.data.motivoAnulacion, "digitada dos veces");
    assert.equal(r.json.data.anuladaPor, "u-admin");
    assert.ok(r.json.data.anuladaAt);
    assert.equal(repo.rows.length, 1);
    assert.equal((await call("GET", "/", "t-admin")).json.data.length, 0);
    assert.equal((await call("GET", "/?incluirAnuladas=true", "t-admin")).json.data.length, 1);
  }));

test("list filters: cedula, tipo, sede, overlap range (inclusive), ordering and shape", () =>
  withApp(
    [
      row({ id: ID_A, fecha_inicio: "2026-11-10", fecha_fin: "2026-11-20" }),
      row({ id: ID_B, cedula: "777777", tipo: "Permisos académicos", fecha_inicio: "2026-12-01", fecha_fin: "2026-12-02", sede_id: "s2" }),
      row({ id: ID_C, cedula: "777777", tipo: "Permisos académicos", fecha_inicio: "2026-01-01", fecha_fin: "2026-01-02" }),
    ],
    async ({ call }) => {
      const ids = async (q) => (await call("GET", `/${q}`, "t-admin")).json.data.map((d) => d.id);
      assert.deepEqual(await ids("?desde=2026-11-18&hasta=2026-11-25"), [ID_A]);
      assert.deepEqual(await ids("?desde=2026-11-20&hasta=2026-11-25"), [ID_A]);
      assert.deepEqual(await ids("?desde=2026-11-21&hasta=2026-11-25"), []);
      assert.deepEqual(await ids("?hasta=2026-11-09"), [ID_C]);
      assert.deepEqual(await ids("?cedula=777.777"), [ID_B, ID_C]);
      assert.deepEqual(await ids("?cedula=777777&sede=s1"), [ID_C]);
      assert.deepEqual(await ids("?tipo=Permisos académicos"), [ID_B, ID_C]);
      const all = await call("GET", "/", "t-admin");
      assert.deepEqual(all.json.data.map((d) => d.id), [ID_B, ID_A, ID_C]); // fecha_inicio desc
      assert.equal(all.json.truncated, false);
      assert.deepEqual(all.json.warnings, []);
    },
  ));

test("default composition root mounts /api/novedades behind authentication (no network needed)", async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/novedades`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, "AUTH_REQUIRED");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---- subtypes, ARL files and uploads --------------------------------------------------------
const arlBody = { ...body, tipo: "Incapacidades", subtipo: "ARL", observacion: "Accidente de trabajo", adjuntoPath: ADJ, firmaPath: FIR, historiaPath: HIS };
const upBody = { kind: "adjunto", fileName: "incapacidad.pdf", contentType: "application/pdf", size: 2048, sedeId: "s1" };

test("create ARL: 201 with responsable from the session, file flags and no paths in the response", () =>
  withApp([], async ({ call, repo }) => {
    const r = await call("POST", "/", "t-planner", { ...arlBody, responsableNombre: "Spoof", responsableId: "evil" });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.tipo, "Incapacidades");
    assert.equal(r.json.data.subtipo, "ARL");
    assert.equal(r.json.data.responsableNombre, "Paula Planner");
    assert.equal(r.json.data.hasAdjunto, true);
    assert.equal(r.json.data.hasFirma, true);
    assert.equal(JSON.stringify(r.json).includes(ADJ), false);
    assert.equal(repo.calls.insert[0].responsable_id, "u-planner");
  }));

test("create ARL: missing files are 400 VALIDATION_ERROR with Spanish messages; nothing is stored", () =>
  withApp([], async ({ call, repo }) => {
    const r = await call("POST", "/", "t-planner", { ...arlBody, adjuntoPath: undefined, firmaPath: undefined, historiaPath: undefined });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "VALIDATION_ERROR");
    const msgs = Object.fromEntries(r.json.details.map((d) => [d.path, d.message]));
    assert.match(msgs["body.adjuntoPath"], /Debes adjuntar el soporte/);
    assert.match(msgs["body.firmaPath"], /firma del líder/);
    assert.match(msgs["body.historiaPath"], /historia clínica/);
    assert.equal(repo.rows.length, 0);
  }));

test("create ARL: paths that were never uploaded are rejected before inserting", () =>
  withApp([], async ({ call, repo }) => {
    const r = await call("POST", "/", "t-planner", { ...arlBody, adjuntoPath: "2026/11/9d5c1f0e-1111-4222-8333-444455556666-adjunto.pdf" });
    assert.equal(r.status, 400);
    assert.equal(r.json.details[0].path, "body.adjuntoPath");
    assert.equal(repo.rows.length, 0);
  }));

test("create: Estudio and Día de la Familia are rejected; Permisos académicos and subtypes are accepted", () =>
  withApp([], async ({ call }) => {
    assert.equal((await call("POST", "/", "t-planner", { ...body, tipo: "Estudio" })).status, 400);
    assert.equal((await call("POST", "/", "t-planner", { ...body, tipo: "Día de la Familia" })).status, 400);
    const acad = { modo: "libre", dias: [{ fecha: "2026-11-03" }, { fecha: "2026-11-14" }], detalle: "Examen final" };
    assert.equal((await call("POST", "/", "t-planner", { ...body, tipo: "Permisos académicos", detalles: acad })).status, 201);
    assert.equal((await call("POST", "/", "t-planner", { ...body, tipo: "Licencias" })).status, 400);
    const ok = await call("POST", "/", "t-planner", { ...body, tipo: "Licencias", subtipo: "Remunerada", detalles: { dias: 3, motivo: "Calamidad" } });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.data.subtipo, "Remunerada");
    assert.deepEqual(ok.json.data.detalles, { dias: 3, motivo: "Calamidad" });
    const eg = { ...body, tipo: "Incapacidades", subtipo: "Enfermedad general", observacion: "Reposo", adjuntoPath: ADJ, detalles: { duracion: "Menor o igual a 3 días" } };
    assert.equal((await call("POST", "/", "t-planner", eg)).status, 201);
  }));

test("create: real sede text is stored for a null-sede employee (admin) and returned", () =>
  withApp([], async ({ call }) => {
    const r = await call("POST", "/", "t-admin", { ...body, sedeId: null, sedeNombre: "CORPORATIVO GENERAL" });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.sedeId, null);
    assert.equal(r.json.data.sedeNombre, "CORPORATIVO GENERAL");
    assert.equal((await call("GET", `/${r.json.data.id}`, "t-admin")).json.data.sedeNombre, "CORPORATIVO GENERAL");
    // access rules unchanged: a planner still cannot create without a sede, whatever the text says
    assert.equal((await call("POST", "/", "t-planner", { ...body, sedeId: null, sedeNombre: "CORPORATIVO GENERAL" })).status, 403);
  }));

test("historical Día de la Familia rows are still listed, read and cancellable but not editable to that tipo", () =>
  withApp([row({ id: ID_A, tipo: "Día de la Familia" })], async ({ call }) => {
    assert.equal((await call("GET", "/?tipo=D%C3%ADa%20de%20la%20Familia", "t-viewer")).json.data[0].tipo, "Día de la Familia");
    assert.equal((await call("GET", `/${ID_A}`, "t-viewer")).json.data.tipo, "Día de la Familia");
    assert.equal((await call("PATCH", `/${ID_A}`, "t-planner", { tipo: "Día de la Familia" })).status, 400);
    assert.equal((await call("PATCH", `/${ID_A}`, "t-planner", { observacion: "x" })).status, 200);
    assert.equal((await call("POST", `/${ID_A}/anular`, "t-planner", { motivo: "m" })).status, 200);
  }));

test("patch: ARL cross-field rules apply on the merged state (400 with details)", () =>
  withApp([row({ id: ID_A, tipo: "Incapacidades", subtipo: "Enfermedad general", observacion: "o", adjunto_path: ADJ, detalles: { duracion: "Menor o igual a 3 días" } })], async ({ call }) => {
    const r = await call("PATCH", `/${ID_A}`, "t-planner", { subtipo: "ARL" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json.details.map((d) => d.path).sort(), ["body.firmaPath", "body.historiaPath"]);
    const ok = await call("PATCH", `/${ID_A}`, "t-planner", { subtipo: "ARL", firmaPath: FIR, historiaPath: HIS });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.responsableNombre, "Paula Planner");
  }));

test("POST /uploads: writers only, validated body, sede-scoped like create", () =>
  withApp([], async ({ call, storage }) => {
    assert.equal((await call("POST", "/uploads", null, upBody)).status, 401);
    assert.equal((await call("POST", "/uploads", "t-viewer", upBody)).json.code, "FORBIDDEN_ROLE");
    assert.equal((await call("POST", "/uploads", "t-viewer", {})).json.code, "FORBIDDEN_ROLE"); // role before validation
    assert.equal((await call("POST", "/uploads", "t-planner", { ...upBody, sedeId: "s2" })).json.code, "FORBIDDEN_SEDE");
    assert.equal((await call("POST", "/uploads", "t-planner", { ...upBody, sedeId: undefined })).json.code, "FORBIDDEN_SEDE");
    assert.equal((await call("POST", "/uploads", "t-admin", { ...upBody, sedeId: undefined })).status, 200);

    const r = await call("POST", "/uploads", "t-planner", upBody);
    assert.equal(r.status, 200);
    assert.match(r.json.path, /^\d{4}\/\d{2}\/[0-9a-f-]{36}-adjunto\.pdf$/);
    assert.equal(r.json.token, "T");
    assert.ok(r.json.signedUploadUrl.includes(r.json.path));
    assert.deepEqual(Object.keys(r.json).sort(), ["path", "signedUploadUrl", "token"]);
    assert.ok(storage.calls.upload.includes(r.json.path));
  }));

test("POST /uploads: 400 for bad content type, size, kind and non-png signatures", () =>
  withApp([], async ({ call, storage }) => {
    for (const bad of [
      { contentType: "text/html" },
      { size: 10 * 1024 * 1024 + 1 },
      { size: 0 },
      { kind: "otro" },
      { kind: "firma", contentType: "image/jpeg" },
      { fileName: "" },
    ]) {
      const r = await call("POST", "/uploads", "t-planner", { ...upBody, ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.json.code, "VALIDATION_ERROR");
    }
    assert.deepEqual(storage.calls.upload, []);
  }));

test("GET /:id/files/:kind: readers get a short-lived signed URL, scoped by the novedad sede", () =>
  withApp(
    [
      row({ id: ID_A, tipo: "Incapacidades", subtipo: "ARL", adjunto_path: ADJ, firma_path: FIR, responsable_id: "u", responsable_nombre: "L" }),
      row({ id: ID_B, sede_id: "s2", tipo: "Incapacidades", subtipo: "ARL", adjunto_path: ADJ, firma_path: FIR }),
      row({ id: ID_C }),
    ],
    async ({ call, storage }) => {
      const a = await call("GET", `/${ID_A}/files/adjunto`, "t-viewer");
      assert.equal(a.status, 200);
      assert.deepEqual(Object.keys(a.json), ["url"]);
      assert.ok(a.json.url.includes(ADJ));
      assert.equal(storage.calls.download[0].expiresIn, 300);
      assert.ok((await call("GET", `/${ID_A}/files/firma`, "t-planner")).json.url.includes(FIR));
      assert.equal((await call("GET", `/${ID_B}/files/adjunto`, "t-viewer")).json.code, "FORBIDDEN_SEDE");
      assert.equal((await call("GET", `/${ID_B}/files/adjunto`, "t-admin")).status, 200);
      assert.equal((await call("GET", `/${ID_C}/files/adjunto`, "t-viewer")).json.code, "NOVEDAD_FILE_NOT_FOUND");
      assert.equal((await call("GET", "/33333333-3333-4333-8333-333333333333/files/adjunto", "t-admin")).status, 404);
      assert.equal((await call("GET", `/${ID_A}/files/otro`, "t-viewer")).status, 400);
      assert.equal((await call("GET", `/${ID_A}/files/adjunto`, null)).status, 401);
      assert.equal((await call("GET", `/${ID_A}/files/adjunto`, "t-norole")).json.code, "FORBIDDEN_ROLE");
    },
  ));

// ---- detalles, historia and soporte ---------------------------------------------------------
test("POST /uploads: historia and soporte get server-generated paths with their own suffix", () =>
  withApp([], async ({ call }) => {
    const h = await call("POST", "/uploads", "t-planner", { ...upBody, kind: "historia" });
    assert.equal(h.status, 200);
    assert.match(h.json.path, /^\d{4}\/\d{2}\/[0-9a-f-]{36}-historia\.pdf$/);
    const s = await call("POST", "/uploads", "t-planner", { ...upBody, kind: "soporte", contentType: "image/jpeg" });
    assert.equal(s.status, 200);
    assert.match(s.json.path, /^\d{4}\/\d{2}\/[0-9a-f-]{36}-soporte\.jpg$/);
    assert.equal((await call("POST", "/uploads", "t-planner", { ...upBody, kind: "historia", contentType: "image/gif" })).status, 400);
  }));

test("GET /:id/files/historia|soporte: signed URLs for readers; 404 when the novedad lacks the file", () =>
  withApp([row({ id: ID_A, tipo: "Permisos", soporte_path: SOP, detalles: { motivo: "m" } }), row({ id: ID_B })], async ({ call }) => {
    const ok = await call("GET", `/${ID_A}/files/soporte`, "t-viewer");
    assert.equal(ok.status, 200);
    assert.ok(ok.json.url.includes(SOP));
    assert.equal((await call("GET", `/${ID_A}/files/historia`, "t-viewer")).json.code, "NOVEDAD_FILE_NOT_FOUND");
    assert.equal((await call("GET", `/${ID_B}/files/soporte`, "t-admin")).json.code, "NOVEDAD_FILE_NOT_FOUND");
    assert.equal((await call("GET", `/${ID_A}/files/otro`, "t-viewer")).status, 400);
  }));

test("create Permisos: detalles errors come back as body.detalles.<field> in Spanish; unknown keys and non-objects are rejected", () =>
  withApp([], async ({ call, repo }) => {
    const permisos = { ...body, tipo: "Permisos" };
    const missing = await call("POST", "/", "t-planner", permisos);
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.json.details, [{ path: "body.detalles.motivo", message: "El motivo del permiso es obligatorio" }]);
    const unknown = await call("POST", "/", "t-planner", { ...permisos, detalles: { motivo: "m", color: "azul" } });
    assert.deepEqual(unknown.json.details, [{ path: "body.detalles.color", message: "Campo no permitido: color" }]);
    const notObject = await call("POST", "/", "t-planner", { ...permisos, detalles: ["x"] });
    assert.deepEqual(notObject.json.details, [{ path: "body.detalles", message: "detalles debe ser un objeto" }]);
    const hours = await call("POST", "/", "t-planner", { ...permisos, detalles: { motivo: "m", porHoras: true, horas: [{ fecha: "2026-11-04", inicio: "09:00", fin: "08:00" }] } });
    assert.deepEqual(hours.json.details.map((d) => d.path), ["body.detalles.horas.0.fin"]);
    assert.equal(repo.rows.length, 0);
  }));

test("create Permisos with soporte and hours: 201 with detalles echoed and the soporte flag", () =>
  withApp([], async ({ call, repo }) => {
    const detalles = { motivo: "Cita médica", porHoras: true, horas: [{ fecha: "2026-11-04", inicio: "08:00", fin: "10:00" }] };
    const r = await call("POST", "/", "t-planner", { ...body, tipo: "Permisos", soportePath: SOP, detalles });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.data.detalles, detalles);
    assert.equal(r.json.data.hasSoporte, true);
    assert.equal(JSON.stringify(r.json).includes(SOP), false);
    assert.equal(repo.rows[0].soporte_path, SOP);
  }));

test("patch: detalles of a legacy row, and the strict rules once tipo/subtipo/detalles are touched", () =>
  withApp([row({ id: ID_A })], async ({ call }) => {
    assert.equal((await call("PATCH", `/${ID_A}`, "t-planner", { observacion: "ok" })).status, 200, "legacy row untouched by the new rules");
    const strict = await call("PATCH", `/${ID_A}`, "t-planner", { detalles: {} });
    assert.equal(strict.status, 400);
    assert.deepEqual(strict.json.details.map((d) => d.path), ["body.detalles.motivo"]);
    const ok = await call("PATCH", `/${ID_A}`, "t-planner", { detalles: { motivo: "Cita" } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.data.detalles, { motivo: "Cita" });
    assert.equal((await call("PATCH", `/${ID_A}`, "t-planner", { detalles: null })).status, 400);
  }));
