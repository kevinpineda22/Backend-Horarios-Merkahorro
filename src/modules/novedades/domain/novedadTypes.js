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

/**
 * Cross-field rules over the camelCase state of a novedad (create body, or a stored row merged
 * with a patch). Returns a list of { path, message }; empty means valid.
 *   Incapacidades -> subtipo ARL | Enfermedad general; Licencias -> Remunerada | No remunerada;
 *   any other tipo -> no subtipo. ARL needs adjunto + firma; everything else must have none.
 */
export function validateNovedadRules({ tipo, subtipo, adjuntoPath, firmaPath }) {
  const issues = [];
  const allowed = SUBTIPOS_BY_TIPO[tipo];
  if (allowed) {
    if (!allowed.includes(subtipo)) {
      issues.push(issue("subtipo", `Debes indicar el subtipo: ${allowed.join(" o ")}.`));
    }
  } else if (subtipo != null) {
    issues.push(issue("subtipo", "Este tipo de novedad no admite subtipo."));
  }

  if (subtipo === SUBTIPO_ARL && tipo === "Incapacidades") {
    if (!adjuntoPath) issues.push(issue("adjuntoPath", "Debes adjuntar el soporte de la incapacidad ARL."));
    if (!firmaPath) issues.push(issue("firmaPath", "Falta la firma del líder responsable."));
  } else {
    if (adjuntoPath) issues.push(issue("adjuntoPath", "Solo las incapacidades ARL admiten adjunto."));
    if (firmaPath) issues.push(issue("firmaPath", "Solo las incapacidades ARL admiten firma."));
  }
  return issues;
}
