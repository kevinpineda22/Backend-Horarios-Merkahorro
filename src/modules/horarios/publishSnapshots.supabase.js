const TABLE = "schedule_publish_snapshots";
const COLUMNS = "id, sede_id, week_start, schedule_version, published_by, published_at, recommendation, suggested, published";

const toDto = (r) => ({
  id: r.id,
  sedeId: r.sede_id,
  weekStart: r.week_start,
  scheduleVersion: r.schedule_version,
  publishedBy: r.published_by,
  publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
  recommendation: r.recommendation ?? null,
  suggested: r.suggested ?? null,
  published: r.published ?? [],
});

/**
 * Publish snapshots (migration 013): one row per publication with what the system recommended, what it suggested and
 * what the leader published. Insert-only; the rows are the history.
 */
export function createPublishSnapshotsRepo(client) {
  return {
    async create({ scheduleId, sedeId, weekStart, scheduleVersion, publishedBy, recommendation, suggested, published }) {
      const { data, error } = await client
        .from(TABLE)
        .insert({
          schedule_id: scheduleId,
          sede_id: sedeId,
          week_start: weekStart,
          schedule_version: scheduleVersion,
          published_by: publishedBy,
          recommendation: recommendation ?? null,
          suggested: suggested ?? null,
          published,
        })
        .select("id")
        .single();
      if (error) throw error;
      return { id: data.id };
    },

    /** The snapshots of one sede, newest publication first. */
    async listBySede({ sedeId, limit }) {
      const { data, error } = await client.from(TABLE).select(COLUMNS).eq("sede_id", sedeId).order("published_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return (data ?? []).map(toDto);
    },

    async findById(id) {
      const { data, error } = await client.from(TABLE).select(COLUMNS).eq("id", id).maybeSingle();
      if (error) throw error;
      return data ? toDto(data) : null;
    },
  };
}
