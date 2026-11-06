import test from "node:test";
import assert from "node:assert/strict";

const { createNovedadesStorage } = await import("../../src/modules/novedades/novedades.storage.js");

// Recording fake of supabase.storage.from(bucket).
function fakeClient(results = {}) {
  const log = [];
  const api = {
    createSignedUploadUrl: async (...a) => (log.push(["createSignedUploadUrl", ...a]), results.upload ?? { data: { signedUrl: "https://s/u", token: "tok", path: "p" }, error: null }),
    exists: async (...a) => (log.push(["exists", ...a]), results.exists ?? { data: true, error: null }),
    createSignedUrl: async (...a) => (log.push(["createSignedUrl", ...a]), results.download ?? { data: { signedUrl: "https://s/d" }, error: null }),
  };
  return { log, client: { storage: { from: (b) => (log.push(["from", b]), api) } } };
}

test("createUploadUrl: signs the path in the private bucket without upsert", async () => {
  const { log, client } = fakeClient();
  const out = await createNovedadesStorage(client).createUploadUrl("2026/11/x-adjunto.pdf");
  assert.deepEqual(log[0], ["from", "novedades-soportes"]);
  assert.deepEqual(log[1], ["createSignedUploadUrl", "2026/11/x-adjunto.pdf"]);
  assert.deepEqual(out, { path: "2026/11/x-adjunto.pdf", signedUrl: "https://s/u", token: "tok" });
});

test("exists: true / false from the bucket, errors propagate", async () => {
  assert.equal(await createNovedadesStorage(fakeClient().client).exists("a"), true);
  assert.equal(await createNovedadesStorage(fakeClient({ exists: { data: false, error: null } }).client).exists("a"), false);
  const boom = new Error("storage down");
  await assert.rejects(createNovedadesStorage(fakeClient({ exists: { data: false, error: boom } }).client).exists("a"), boom);
});

test("createDownloadUrl: short-lived signed URL", async () => {
  const { log, client } = fakeClient();
  assert.equal(await createNovedadesStorage(client).createDownloadUrl("a/b.pdf", 300), "https://s/d");
  assert.deepEqual(log[1], ["createSignedUrl", "a/b.pdf", 300]);
});

test("storage errors are thrown (never swallowed into a fake URL)", async () => {
  const boom = new Error("nope");
  await assert.rejects(createNovedadesStorage(fakeClient({ upload: { data: null, error: boom } }).client).createUploadUrl("a"), boom);
  await assert.rejects(createNovedadesStorage(fakeClient({ download: { data: null, error: boom } }).client).createDownloadUrl("a", 1), boom);
});
