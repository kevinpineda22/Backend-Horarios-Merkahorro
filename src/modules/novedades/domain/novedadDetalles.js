import { z } from "zod";
import { toEpochDay } from "../../sugerido/domain/dates.js";

// Per-type details of a novedad (the `detalles` jsonb column). Each tipo/subtipo has its own strict zod
// schema; unknown keys are rejected. Pure: no I/O.
//
//   validateDetalles({ tipo, subtipo, fechaInicio, fechaFin, detalles }, { lenient })
//     -> { issues: [{ path, message }], data }
//
// `path` is relative to the request body ("detalles.motivo", "detalles.horas.0.fin", or a root field such as
// "fechaInicio" for the cross-field date rules). `data` is the normalized object to store (trimmed text, optional
// empties dropped, days sorted) and is null when there are issues. `lenient` is for rows created before the
// column existed (detalles = {}): required fields are not enforced, but whatever is present is still validated.

export const DURACIONES_ENFERMEDAD_GENERAL = Object.freeze(["Mayor a 3 días", "Menor o igual a 3 días"]);
export const MODOS_PERMISO_ACADEMICO = Object.freeze(["parcial", "libre", "redistribuir"]);
export const MAX_DIAS_DETALLE = 62;
export const MAX_DIAS_LICENCIA = 366;
const DURACION_MENOR = DURACIONES_ENFERMEDAD_GENERAL[1];

const MAX_TEXT = 1000;
const MAX_LIDER = 120;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const FOUR_DIGITS = /^[0-9]{4}$/;

const MSG_DATE = "Fecha inválida (use AAAA-MM-DD)";
const MSG_TIME = "Hora inválida (use HH:MM)";
const MSG_FIN_AFTER_INICIO = "La hora fin debe ser posterior a la hora inicio";
const MSG_HORAS = "Debes agregar al menos un día con su rango de horas";

const isIsoDate = (v) => {
  if (typeof v !== "string") return false;
  try {
    toEpochDay(v);
    return true;
  } catch {
    return false;
  }
};
const isHhmm = (v) => typeof v === "string" && HHMM.test(v);
const nfc = (v) => (typeof v === "string" ? v.normalize("NFC") : v);
const inRange = (fecha, { fechaInicio, fechaFin }) =>
  !isIsoDate(fechaInicio) || !isIsoDate(fechaFin) || (fecha >= fechaInicio && fecha <= fechaFin);

// ---- field builders ----------------------------------------------------------------------------
const oneOf = (values, message) => z.preprocess(nfc, z.enum(values, { errorMap: () => ({ message }) }));

const text = (label, max, message) =>
  z
    .string({ required_error: message, invalid_type_error: message })
    .transform((s) => s.trim())
    .pipe(z.string().min(1, message).max(max, `${label} no puede superar ${max} caracteres`));

const optionalText = (label, max) =>
  z
    .string({ invalid_type_error: `${label} debe ser texto` })
    .nullish()
    .transform((v) => (v == null ? undefined : v.trim() || undefined))
    .pipe(z.string().max(max, `${label} no puede superar ${max} caracteres`).optional());

const dateField = z.string({ required_error: MSG_DATE, invalid_type_error: MSG_DATE }).refine(isIsoDate, { message: MSG_DATE });
const timeField = z.string({ required_error: MSG_TIME, invalid_type_error: MSG_TIME }).regex(HHMM, MSG_TIME);

const optionalDate = z
  .string({ invalid_type_error: MSG_DATE })
  .nullish()
  .transform((v) => (v == null || v === "" ? undefined : v))
  .pipe(dateField.optional());

const optionalTime = z
  .string({ invalid_type_error: MSG_TIME })
  .nullish()
  .transform((v) => (v == null || v === "" ? undefined : v))
  .pipe(timeField.optional());

// ---- schemas per tipo --------------------------------------------------------------------------
const empty = () => z.object({}).strict();

function enfermedadGeneral(need, range) {
  const message = `Debes indicar la duración: ${DURACIONES_ENFERMEDAD_GENERAL.join(" o ")}.`;
  return z
    .object({ duracion: need(oneOf(DURACIONES_ENFERMEDAD_GENERAL, message)) })
    .strict()
    .superRefine((d, ctx) => {
      // The old form derived the duration from the dates: more than 3 inclusive days is always "Mayor a 3 días".
      if (d.duracion !== DURACION_MENOR || !isIsoDate(range.fechaInicio) || !isIsoDate(range.fechaFin)) return;
      if (toEpochDay(range.fechaFin) - toEpochDay(range.fechaInicio) + 1 > 3) {
        ctx.addIssue({ code: "custom", path: ["duracion"], message: "Con más de 3 días la duración es «Mayor a 3 días»." });
      }
    });
}

function licencias(need) {
  const diasMsg = "Los días de la licencia deben ser un número entero mayor a 0";
  return z
    .object({
      dias: need(z.number({ required_error: diasMsg, invalid_type_error: diasMsg }).int(diasMsg).positive(diasMsg).max(MAX_DIAS_LICENCIA, `Los días de la licencia no pueden superar ${MAX_DIAS_LICENCIA}`)),
      motivo: need(text("El motivo", MAX_TEXT, "El motivo de la licencia es obligatorio")),
      liderAprueba: optionalText("El líder que aprueba", MAX_LIDER),
      fechaAprobacion: optionalDate,
    })
    .strict();
}

function permisos(need, range) {
  const hora = z
    .object({ fecha: dateField, inicio: timeField, fin: timeField })
    .strict()
    .superRefine((h, ctx) => {
      if (isHhmm(h.inicio) && isHhmm(h.fin) && h.fin <= h.inicio) {
        ctx.addIssue({ code: "custom", path: ["fin"], message: MSG_FIN_AFTER_INICIO });
      }
      if (isIsoDate(h.fecha) && !inRange(h.fecha, range)) {
        ctx.addIssue({ code: "custom", path: ["fecha"], message: "La fecha debe estar dentro del rango de la novedad" });
      }
    });
  return z
    .object({
      motivo: need(text("El motivo", MAX_TEXT, "El motivo del permiso es obligatorio")),
      porHoras: z
        .boolean({ invalid_type_error: "porHoras debe ser verdadero o falso" })
        .nullish()
        .transform((v) => v ?? undefined),
      horas: z
        .array(hora, { invalid_type_error: "Las horas deben ser una lista de días con su rango de horas" })
        .max(MAX_DIAS_DETALLE, `No puedes registrar más de ${MAX_DIAS_DETALLE} días con horas`)
        .nullish()
        .transform((v) => v ?? undefined),
    })
    .strict()
    .superRefine((d, ctx) => {
      const count = d.horas?.length ?? 0;
      if (d.porHoras === true && count === 0) ctx.addIssue({ code: "custom", path: ["horas"], message: MSG_HORAS });
      if (d.porHoras !== true && count > 0) {
        ctx.addIssue({ code: "custom", path: ["horas"], message: "Solo los permisos por horas admiten horas" });
      }
    });
}

function permisosAcademicos(need, range, lenient) {
  const diasMsg = "Debes seleccionar al menos un día";
  const dia = z.object({ fecha: dateField, inicio: optionalTime, fin: optionalTime }).strict();
  return z
    .object({
      modo: need(oneOf(MODOS_PERMISO_ACADEMICO, `Debes indicar el modo: ${MODOS_PERMISO_ACADEMICO.slice(0, -1).join(", ")} o ${MODOS_PERMISO_ACADEMICO.at(-1)}`)),
      dias: need(
        z
          .array(dia, { required_error: diasMsg, invalid_type_error: diasMsg })
          .min(1, diasMsg)
          .max(MAX_DIAS_DETALLE, `No puedes seleccionar más de ${MAX_DIAS_DETALLE} días`),
      ),
      detalle: need(text("El detalle", MAX_TEXT, "El detalle del permiso académico es obligatorio")),
    })
    .strict()
    .superRefine((d, ctx) => {
      const add = (path, message, root) =>
        ctx.addIssue({ code: "custom", path, message, ...(root ? { params: { root } } : {}) });

      // Hours are per day (like the old EstudioForm): required for parcial, forbidden for libre / redistribuir.
      if (Array.isArray(d.dias) && d.modo !== undefined) {
        d.dias.forEach((x, i) => {
          if (d.modo === "parcial") {
            if (!lenient && x.inicio === undefined) add(["dias", i, "inicio"], "La hora de inicio es obligatoria para el modo parcial");
            if (!lenient && x.fin === undefined) add(["dias", i, "fin"], "La hora de fin es obligatoria para el modo parcial");
            if (isHhmm(x.inicio) && isHhmm(x.fin) && x.fin <= x.inicio) add(["dias", i, "fin"], MSG_FIN_AFTER_INICIO);
          } else {
            if (x.inicio !== undefined) add(["dias", i, "inicio"], "Solo el modo parcial admite horario");
            if (x.fin !== undefined) add(["dias", i, "fin"], "Solo el modo parcial admite horario");
          }
        });
      }

      if (!Array.isArray(d.dias) || d.dias.length === 0 || !d.dias.every((x) => isIsoDate(x.fecha))) return;
      const seen = new Set();
      d.dias.forEach((x, i) => {
        if (seen.has(x.fecha)) add(["dias", i, "fecha"], "El día está repetido");
        seen.add(x.fecha);
      });
      const sorted = [...seen].sort();
      const first = sorted[0];
      const last = sorted.at(-1);
      if (isIsoDate(range.fechaInicio) && range.fechaInicio !== first) {
        add([], `fechaInicio debe ser el primer día seleccionado (${first})`, "fechaInicio");
      }
      if (isIsoDate(range.fechaFin) && range.fechaFin !== last) {
        add([], `fechaFin debe ser el último día seleccionado (${last})`, "fechaFin");
      }
    });
}

function vacaciones(range, lenient) {
  const periodoMsg = "El periodo debe ser un año de 4 dígitos";
  return z
    .object({
      periodo: z
        .preprocess(
          (v) => (typeof v === "number" && Number.isInteger(v) ? String(v) : v),
          z.string({ invalid_type_error: periodoMsg }).regex(FOUR_DIGITS, periodoMsg).nullish(),
        )
        .transform((v) => v ?? undefined),
      fechaRegreso: optionalDate,
    })
    .strict()
    .superRefine((d, ctx) => {
      if (!lenient && d.periodo === undefined) ctx.addIssue({ code: "custom", path: ["periodo"], message: "El periodo es obligatorio (año de 4 dígitos)" });
      if (!lenient && d.fechaRegreso === undefined) ctx.addIssue({ code: "custom", path: ["fechaRegreso"], message: "La fecha de regreso es obligatoria" });
      if (isIsoDate(d.fechaRegreso) && isIsoDate(range.fechaFin) && d.fechaRegreso < range.fechaFin) {
        ctx.addIssue({ code: "custom", path: ["fechaRegreso"], message: "La fecha de regreso no puede ser anterior a fechaFin" });
      }
    });
}

function schemaFor({ tipo, subtipo, fechaInicio, fechaFin }, lenient) {
  const need = (schema) => (lenient ? schema.optional() : schema);
  const range = { fechaInicio, fechaFin };
  switch (tipo) {
    case "Incapacidades":
      return subtipo === "Enfermedad general" ? enfermedadGeneral(need, range) : empty();
    case "Licencias":
      return licencias(need);
    case "Permisos":
      return permisos(need, range);
    case "Permisos académicos":
      return permisosAcademicos(need, range, lenient);
    case "Vacaciones":
      return vacaciones(range, lenient);
    default:
      return empty();
  }
}

// ---- adapter -----------------------------------------------------------------------------------
const toPath = (parts) => parts.join(".");

function toIssues(zodIssues) {
  const out = [];
  for (const issue of zodIssues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) out.push({ path: toPath(["detalles", ...issue.path, key]), message: `Campo no permitido: ${key}` });
    } else if (issue.params?.root) {
      out.push({ path: issue.params.root, message: issue.message });
    } else {
      out.push({ path: toPath(["detalles", ...issue.path]), message: issue.message });
    }
  }
  return out;
}

const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

function normalize(tipo, data) {
  const out = compact(data);
  if (tipo === "Permisos" && out.porHoras !== true) delete out.horas;
  if (tipo === "Permisos académicos" && Array.isArray(out.dias)) {
    out.dias = [...out.dias].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  }
  return out;
}

export function validateDetalles(state, { lenient = false } = {}) {
  const raw = state.detalles === undefined ? {} : state.detalles;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { issues: [{ path: "detalles", message: "detalles debe ser un objeto" }], data: null };
  }
  const result = schemaFor(state, lenient).safeParse(raw);
  if (!result.success) return { issues: toIssues(result.error.issues), data: null };
  return { issues: [], data: normalize(state.tipo, result.data) };
}
