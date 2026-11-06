import test from "node:test";
import assert from "node:assert/strict";

import { resolveWeeks, requestWithRetry, runDaily, DEFAULT_BASE_URL } from "../../scripts/daily-suggestion.mjs";

const NOW = new Date("2026-11-04T11:00:00Z"); // Wednesday
const json = (status, body) => ({ status, ok: status < 400, json: async () => body });

test("resolveWeeks maps current/next, dedupes, and rejects unknown tokens", () => {
  assert.deepEqual(resolveWeeks("current,next", NOW), ["2026-11-02", "2026-11-09"]);
  assert.deepEqual(resolveWeeks(" next , next ", NOW), ["2026-11-09"]);
  assert.deepEqual(resolveWeeks("", NOW), ["2026-11-02", "2026-11-09"], "blank falls back to the default");
  assert.deepEqual(resolveWeeks(undefined, NOW), ["2026-11-02", "2026-11-09"]);
  assert.throws(() => resolveWeeks("current,last", NOW), /last/);
});

test("requestWithRetry retries once on 5xx and on a network error, never on 4xx", async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? json(502, {}) : json(201, { ok: true }));
  assert.equal((await requestWithRetry(flaky, "u", {})).status, 201);
  assert.equal(n, 2);

  n = 0;
  const throwing = async () => { if (++n === 1) throw new Error("timeout"); return json(200, {}); };
  assert.equal((await requestWithRetry(throwing, "u", {})).status, 200);

  n = 0;
  const bad = async () => (++n, json(404, {}));
  assert.equal((await requestWithRetry(bad, "u", {})).status, 404);
  assert.equal(n, 1);

  n = 0;
  const down = async () => (++n, json(500, {}));
  assert.equal((await requestWithRetry(down, "u", {})).status, 500);
  assert.equal(n, 2, "exactly one retry");

  n = 0;
  const dead = async () => { ++n; throw new Error("boom"); };
  const r = await requestWithRetry(dead, "u", {});
  assert.deepEqual([r.status, n], [0, 2]);
});

test("runDaily runs every sede x week, sends the key header, continues after a failure and reports it", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init.method, key: init.headers["x-service-key"] });
    if (url.endsWith("/service/sedes")) return json(200, { data: [{ sedeId: "s1" }, { sedeId: "s2" }] });
    if (url.includes("/sedes/s1/weeks/2026-11-02/")) return json(422, { code: "X" });
    return json(201, { data: { version: 3, dataAsOf: "2026-11-03" } });
  };
  const lines = [];
  const out = await runDaily({ fetchFn, baseUrl: "https://x.test/", key: "k", weeks: ["2026-11-02", "2026-11-09"], log: (l) => lines.push(l) });

  assert.equal(calls.length, 5); // 1 list + 4 runs, none skipped after the failure
  assert.ok(calls.every((c) => c.key === "k"));
  assert.ok(calls[1].url.startsWith("https://x.test/api/sugerido/service/sedes/s1/weeks/"), "trailing slash normalized");
  assert.deepEqual([out.total, out.failed], [4, 1]);
  assert.match(lines.join("\n"), /s1 2026-11-02 -> 422/);
  assert.match(lines.join("\n"), /s2 2026-11-09 -> 201 v3 dataAsOf=2026-11-03/);
  assert.doesNotMatch(lines.join("\n"), /\bk\b.*key|x-service-key/i);
});

test("runDaily fails (without running anything) when the sede list cannot be read", async () => {
  const out = await runDaily({ fetchFn: async () => json(401, {}), baseUrl: DEFAULT_BASE_URL, key: "k", weeks: ["2026-11-02"], log: () => {} });
  assert.deepEqual([out.total, out.failed, out.listFailed], [0, 0, true]);
});
