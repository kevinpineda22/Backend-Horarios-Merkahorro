const TABLE = "schedule_publish_snapshots";

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
  };
}
