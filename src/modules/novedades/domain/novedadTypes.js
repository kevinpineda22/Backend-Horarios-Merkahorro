// Canonical absence types. Must match the CHECK in db/migrations/002_novedades.sql and the
// default `blocking_absence_types` seeded in 001. "Día de la Familia" is NFC-normalized.
export const NOVEDAD_TYPES = Object.freeze([
  "Incapacidades",
  "Licencias",
  "Vacaciones",
  "Permisos",
  "Estudio",
  "Día de la Familia",
]);
