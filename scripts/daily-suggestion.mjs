#!/usr/bin/env node
// Daily cashier-suggestion recalculation, run by .github/workflows/daily-suggestion.yml.
// Lists the active sedes and POSTs a run for every sede x target week through the service-key
// endpoints. Node 20, no dependencies. Never prints the key.
//
// Env: SUGERIDO_CRON_KEY (required), BACKEND_URL (optional), WEEKS (optional, default "current,next").
import { pathToFileURL } from "node:url";
import { targetWeeks } from "../src/modules/sugerido/domain/targetWeeks.js";

export const DEFAULT_BASE_URL = "https://backend-horarios-merkahorro.vercel.app";
export const DEFAULT_WEEKS = "current,next";
const TIMEOUT_MS = 60_000;

/** "current,next" -> ['YYYY-MM-DD', ...] (Mondays, Bogota calendar). Blank means the default. */
export function resolveWeeks(spec, now = new Date()) {
  const tokens = String(spec ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const weeks = targetWeeks(now);
  const out = [];
  for (const token of tokens.length ? tokens : DEFAULT_WEEKS.split(",")) {
    if (!(token in weeks)) throw new Error(`Unknown week "${token}" (use current and/or next)`);
    if (!out.includes(weeks[token])) out.push(weeks[token]);
  }
  return out;
}

/** One request, retried once on a network error/timeout or a 5xx. Resolves { status, body }; status 0 = no response. */
export async function requestWithRetry(fetchFn, url, init = {}, { retries = 1, timeoutMs = TIMEOUT_MS } = {}) {
  let last = { status: 0, body: null };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      last = { status: res.status, body: await res.json().catch(() => null) };
      if (res.status < 500) return last;
    } catch {
      last = { status: 0, body: null };
    }
  }
  return last;
}

export async function runDaily({ fetchFn = fetch, baseUrl = DEFAULT_BASE_URL, key, weeks, log = console.log }) {
  const root = `${String(baseUrl).replace(/\/+$/, "")}/api/sugerido/service`;
  const headers = { "x-service-key": key };

  const list = await requestWithRetry(fetchFn, `${root}/sedes`, { method: "GET", headers });
  const sedes = list.body?.data;
  if (list.status !== 200 || !Array.isArray(sedes)) {
    log(`sede list failed -> ${list.status || "no response"}${list.body?.code ? ` ${list.body.code}` : ""}`);
    return { total: 0, failed: 0, listFailed: true };
  }

  let total = 0;
  let failed = 0;
  for (const { sedeId } of sedes) {
    for (const week of weeks) {
      total += 1;
      const url = `${root}/sedes/${encodeURIComponent(sedeId)}/weeks/${week}/runs`;
      const res = await requestWithRetry(fetchFn, url, { method: "POST", headers });
      if (res.status === 200 || res.status === 201) {
        const { version, dataAsOf } = res.body?.data ?? {};
        log(`${sedeId} ${week} -> ${res.status} ${version == null ? "not persisted" : `v${version}`} dataAsOf=${dataAsOf ?? "none"}`);
      } else {
        failed += 1;
        log(`${sedeId} ${week} -> ${res.status || "no response"}${res.body?.code ? ` ${res.body.code}` : ""} FAILED`);
      }
    }
  }
  return { total, failed, listFailed: false };
}

async function main() {
  const key = process.env.SUGERIDO_CRON_KEY;
  if (!key) {
    console.error("SUGERIDO_CRON_KEY is not set");
    process.exit(1);
  }
  const weeks = resolveWeeks(process.env.WEEKS);
  const baseUrl = process.env.BACKEND_URL?.trim() || DEFAULT_BASE_URL;
  console.log(`weeks: ${weeks.join(", ")}`);
  const { total, failed, listFailed } = await runDaily({ baseUrl, key, weeks });
  console.log(`done: ${total - failed}/${total} runs ok`);
  if (listFailed || failed > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`daily run crashed: ${err.message}`);
    process.exit(1);
  });
}
