// How far what a leader published is from what the system suggested, day by day (one cell = one person on one date).
// A cell is the same when the kind (TRABAJO / DESCANSO / COMPENSATORIO...) and the hours match. The lunch alone does
// not count as a change: it is moved for the payroll band, not to change who works when.

const key = (row) => `${row.cedula}|${row.fecha}`;
const signature = (row) => (row.tipo === "TRABAJO" ? `TRABAJO ${row.startTime}-${row.endTime}` : row.tipo);

/**
 * @returns { days, same, changed, added (only in published), removed (only in suggested), people, peopleChanged },
 *   or null without a suggestion to compare with
 */
export function diffSnapshotRows(suggested, published, teamCedulas = null) {
  if (!Array.isArray(suggested)) return null;
  // Only the team of the suggestion: people of other cargos scheduled by hand the same week are not "changes".
  const team = Array.isArray(teamCedulas) ? new Set(teamCedulas.map(String)) : null;
  const inTeam = (row) => !team || team.has(String(row.cedula));
  const before = new Map(suggested.map((row) => [key(row), signature(row)]));
  const after = new Map((published ?? []).filter(inTeam).map((row) => [key(row), signature(row)]));
  const keys = new Set([...before.keys(), ...after.keys()]);
  const result = { days: keys.size, same: 0, changed: 0, added: 0, removed: 0, people: 0, peopleChanged: 0 };
  const people = new Set();
  const changedPeople = new Set();
  for (const k of keys) {
    const cedula = k.split("|")[0];
    people.add(cedula);
    if (!before.has(k)) result.added += 1;
    else if (!after.has(k)) result.removed += 1;
    else if (before.get(k) === after.get(k)) {
      result.same += 1;
      continue;
    } else result.changed += 1;
    changedPeople.add(cedula);
  }
  result.people = people.size;
  result.peopleChanged = changedPeople.size;
  return result;
}
