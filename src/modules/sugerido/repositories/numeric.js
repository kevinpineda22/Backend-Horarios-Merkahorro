/**
 * Supabase serializes Postgres `numeric` as a string ("42", "0.85"). Parse it and fail loudly
 * on null, blank or non-finite values: Number(null) and Number("") would silently become 0.
 */
export function parseNumeric(value, field) {
  const blank = value === null || value === undefined || (typeof value === "string" && value.trim() === "");
  const n = blank ? NaN : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric value for ${field}`);
  return n;
}

/** Like parseNumeric but keeps null (nullable integer columns). */
export function parseNullableNumeric(value, field) {
  return value === null || value === undefined ? null : parseNumeric(value, field);
}
