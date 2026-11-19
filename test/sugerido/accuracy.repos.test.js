import test from "node:test";
import assert from "node:assert/strict";

import { fakeSupabase, has } from "./helpers.js";

process.env.NODE_ENV = "test";
const { createSuggestionsRepo } = await import("../../src/modules/sugerido/repositories/suggestions.supabase.js");
const { createPublishSnapshotsRepo } = await import("../../src/modules/horarios/publishSnapshots.supabase.js");

test("getRunByVersion filters by sede, week and exact version; null when missing", async () => {
  const run = { id: "r1", sede_id: "s1", week_start: "2026-11-02", version: 3, settings: {}, inputs: { productivity: 40 }, flags: {}, warnings: [], data_as_of: "2026-10-31" };
  const { client, log } = fakeSupabase({ tables: { sugerido_runs: { data: run, error: null }, sugerido_slots: { data: [], error: null } } });
  const found = await createSuggestionsRepo(client).getRunByVersion("s1", "2026-11-02", 3);
  assert.equal(found.version, 3);
  assert.ok(has(log, "eq", "sede_id", "s1") && has(log, "eq", "week_start", "2026-11-02") && has(log, "eq", "version", 3));
  const none = fakeSupabase({ tables: { sugerido_runs: { data: null, error: null } } });
  assert.equal(await createSuggestionsRepo(none.client).getRunByVersion("s1", "2026-11-02", 9), null);
});

test("findLatestByWeek takes the newest publication of the sede/week", async () => {
  const row = { id: "sn1", sede_id: "s1", week_start: "2026-11-02", schedule_version: 2, published_by: "u", published_at: "2026-11-01T10:00:00Z", recommendation: { runVersion: 3 }, suggested: null, published: [] };
  const { client, log } = fakeSupabase({ tables: { schedule_publish_snapshots: { data: row, error: null } } });
  const snap = await createPublishSnapshotsRepo(client).findLatestByWeek({ sedeId: "s1", weekStart: "2026-11-02" });
  assert.equal(snap.id, "sn1");
  assert.ok(has(log, "eq", "sede_id", "s1") && has(log, "eq", "week_start", "2026-11-02"));
  assert.ok(has(log, "eq", "team_key", "CAJEROS"), "cashier snapshots by default");
  assert.ok(has(log, "order", "published_at", { ascending: false }));
  const none = fakeSupabase({ tables: { schedule_publish_snapshots: { data: null, error: null } } });
  assert.equal(await createPublishSnapshotsRepo(none.client).findLatestByWeek({ sedeId: "s1", weekStart: "2026-11-02" }), null);
});
