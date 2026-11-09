// Canonical absence types. Must match the CHECK in db/migrations/006_novedades_arl.sql and the
// default `blocking_absence_types` of sugerido_settings. All labels are NFC-normalized.

// Every tipo that may exist in the table (reads, filters, scheduler blocking types).
// "Día de la Familia" only survives as history: it can no longer be created.
export const NOVEDAD_TYPES = Object.freeze([
  "Incapacidades",
  "Licencias",
  "Vacaciones",
  "Permisos",
  "Permisos académicos",
  "Día de la Familia",
]);

// Types the API accepts on create and patch.
export const NOVEDAD_CREATABLE_TYPES = Object.freeze(NOVEDAD_TYPES.filter((t) => t !== "Día de la Familia"));

export const SUBTIPO_ARL = "ARL";

export const SUBTIPOS_BY_TIPO = Object.freeze({
  Incapacidades: Object.freeze([SUBTIPO_ARL, "Enfermedad general"]),
  Licencias: Object.freeze(["Remunerada", "No remunerada"]),
});

export const ALL_SUBTIPOS = Object.freeze([...new Set(Object.values(SUBTIPOS_BY_TIPO).flat())]);

const issue = (path, message) => ({ path, message });

const FILE_KEYS = Object.freeze(["adjuntoPath", "firmaPath", "historiaPath", "soportePath"]);
const MAYOR_A_3_DIAS = "Mayor a 3 días";

const isEmpty = (v) => v == null || (typeof v === "string" && v.trim() === "");

/** Which support files a novedad may / must carry. `detalles.duracion` decides the historia of an enfermedad general. */
function fileRules({ tipo, subtipo, detalles }) {
  const incapacidad = tipo === "Incapacidades";
  const arl = incapacidad && subtipo === SUBTIPO_ARL;
  return {
    adjuntoPath: { allowed: incapacidad, required: incapacidad },
    firmaPath: { allowed: arl, required: arl },
    historiaPath: { allowed: incapacidad, required: arl || (incapacidad && detalles?.duracion === MAYOR_A_3_DIAS) },
    soportePath: { allowed: tipo === "Permisos" || tipo === "Permisos académicos", required: false },
  };
}

/** The file keys (adjuntoPath, firmaPath, ...) a novedad in this state may carry. */
export function allowedFileKeys(state) {
  const rules = fileRules(state);
  return FILE_KEYS.filter((k) => rules[k].allowed);
}

const MISSING = (state) => ({
  adjuntoPath: state.subtipo === SUBTIPO_ARL ? "Debes adjuntar el soporte de la incapacidad ARL." : "Debes adjuntar el soporte de la incapacidad.",
  firmaPath: "Falta la firma del líder responsable.",
  historiaPath: "Debes adjuntar la historia clínica.",
});
const FORBIDDEN = {
  adjuntoPath: "Solo las incapacidades admiten adjunto.",
  firmaPath: "Solo las incapacidades ARL admiten firma.",
  historiaPath: "Solo las incapacidades admiten historia clínica.",
  soportePath: "Solo los permisos admiten soporte.",
};

/**
 * Cross-field rules over the camelCase state of a novedad (create body, or a stored row merged
 * with a patch). Returns a list of { path, message }; empty means valid.
 *   Subtipo: Incapacidades -> ARL | Enfermedad general; Licencias -> Remunerada | No remunerada;
 *            any other tipo -> none.
 *   Incapacidades: observacion and adjunto are mandatory; historia is mandatory for ARL and for
 *            "Mayor a 3 días"; firma only (and always) for ARL.
 *   Permisos / Permisos académicos: optional soporte. Everything else carries no files.
 * Without `touched` every rule runs. With `touched` (a Set of the patch keys, for rows that may predate the
 * rules) only what the patch touched is judged: a touched file must be allowed and a required one cannot be
 * emptied; the subtipo rule runs when a file is touched; the observation of an incapacidad cannot be cleared.
 */
export function validateNovedadRules(state, { touched } = {}) {
  const { tipo, subtipo } = state;
  const issues = [];
  const judges = (key) => !touched || touched.has(key);
  const anyFileTouched = !touched || FILE_KEYS.some((k) => touched.has(k));

  if (anyFileTouched) {
    const allowed = SUBTIPOS_BY_TIPO[tipo];
    if (allowed) {
      if (!allowed.includes(subtipo)) {
        issues.push(issue("subtipo", `Debes indicar el subtipo: ${allowed.join(" o ")}.`));
      }
    } else if (subtipo != null) {
      issues.push(issue("subtipo", "Este tipo de novedad no admite subtipo."));
    }
  }

  if (tipo === "Incapacidades" && judges("observacion") && isEmpty(state.observacion)) {
    issues.push(issue("observacion", "La observación es obligatoria para las incapacidades."));
  }

  const rules = fileRules(state);
  const missing = MISSING(state);
  for (const key of FILE_KEYS) {
    if (!judges(key)) continue;
    const present = !isEmpty(state[key]);
    if (present && !rules[key].allowed) issues.push(issue(key, FORBIDDEN[key]));
    else if (!present && rules[key].required) issues.push(issue(key, missing[key]));
  }
  return issues;
}
