// Supporting files of a novedad live in a PRIVATE Supabase Storage bucket; the API only deals
// with object paths. Paths are always generated server-side (never from the client file name).
export const NOVEDADES_BUCKET = "novedades-soportes";
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // keep equal to the bucket file_size_limit (006)
export const DOWNLOAD_URL_TTL_SECONDS = 300;

export const FILE_KINDS = Object.freeze(["adjunto", "firma"]);

const EXT_BY_MIME = Object.freeze({
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
});
export const ALLOWED_MIME_TYPES = Object.freeze(Object.keys(EXT_BY_MIME));

/** The signature must be a PNG; the incapacity document may be any allowed type. */
export function isAllowedContentType(kind, contentType) {
  if (kind === "firma") return contentType === "image/png";
  return Object.hasOwn(EXT_BY_MIME, contentType);
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH_RE = {
  // String.raw keeps the backslash: the dots must be literal (same patterns as novedades_paths_chk in 006).
  adjunto: new RegExp(String.raw`^[0-9]{4}/(0[1-9]|1[0-2])/${UUID}-adjunto\.(pdf|png|jpg|webp)$`),
  firma: new RegExp(String.raw`^[0-9]{4}/(0[1-9]|1[0-2])/${UUID}-firma\.png$`),
};

/** True when `path` has exactly the shape buildObjectPath generates for `kind`. */
export function isValidObjectPath(kind, path) {
  return typeof path === "string" && FILE_KINDS.includes(kind) && PATH_RE[kind].test(path);
}

/** `${yyyy}/${mm}/${uuid}-${kind}.${ext}` (UTC month). */
export function buildObjectPath({ kind, contentType, now, id }) {
  const yyyy = String(now.getUTCFullYear()).padStart(4, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}/${mm}/${id}-${kind}.${EXT_BY_MIME[contentType]}`;
}
