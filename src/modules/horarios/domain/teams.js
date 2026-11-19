// Schedule teams (migration 015): a sede-week has one schedule per team, each with its own version, state and publication.
//   CAJEROS            the cashier team
//   CARGO:<CARGO>      any other cargo, as in the employee directory, trimmed and uppercased
//   SIN_CARGO          people without cargo
// The client sends the team; the backend never derives membership from the directory.
export const TEAM_CAJEROS = "CAJEROS";
export const TEAM_SIN_CARGO = "SIN_CARGO";
export const TEAM_KEY_MAX_LENGTH = 120;

const TEAM_KEY_RE = /^(CAJEROS|SIN_CARGO|CARGO:\S.*)$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/** Trimmed + uppercased, the form stored in the database. */
export const normalizeTeamKey = (value) => String(value ?? "").trim().toUpperCase();

export function isValidTeamKey(value) {
  return (
    typeof value === "string" &&
    value.length <= TEAM_KEY_MAX_LENGTH &&
    TEAM_KEY_RE.test(value) &&
    !CONTROL_CHARS_RE.test(value) &&
    value === value.trim()
  );
}

/** The team key of a cargo as the directory spells it: null/blank -> SIN_CARGO. */
export const teamKeyForCargo = (cargo) => {
  const normalized = normalizeTeamKey(cargo);
  return normalized ? `CARGO:${normalized}` : TEAM_SIN_CARGO;
};
