import { createHttpError } from "../../../shared/http/HttpError.js";
import { normalizeFranja } from "../domain/dates.js";
import { parseNullableNumeric, parseNumeric } from "./numeric.js";

const FK_VIOLATION = "23503";

const notMapped = () => createHttpError(404, "La sede no está configurada para el sugerido.", "SEDE_NOT_MAPPED");

function unwrap({ data, error }) {
  if (!error) return data;
  if (error.code === FK_VIOLATION) throw notMapped();
  throw error;
}

function unexpected(what) {
  return new Error(`Unexpected ${what} result`);
}

function toSlot(s) {
  return {
    fecha: s.fecha,
    franja: normalizeFranja(s.franja),
    forecastDocs: parseNumeric(s.forecast_docs, "forecast_docs"),
    forecastVenta: parseNumeric(s.forecast_venta, "forecast_venta"),
    required: parseNullableNumeric(s.required, "required"),
    available: parseNumeric(s.available, "available"),
    suggested: parseNullableNumeric(s.suggested, "suggested"),
    shortfall: parseNullableNumeric(s.shortfall, "shortfall"),
    status: s.status,
  };
}

const toSedeDto = (r) => ({ sedeId: r.sede_id, nombre: r.nombre, bodegas: r.bodegas, activo: r.activo });

/** Sedes, suggestion runs and overrides over Supabase (client injected; fakes in tests). */
export function createSuggestionsRepo(client) {
  return {
    async listSedes() {
      const rows = unwrap(await client.from("sugerido_sedes").select("sede_id, nombre, bodegas, activo").order("sede_id", { ascending: true }));
      return (rows ?? []).map(toSedeDto);
    },

    /** Unknown sede, or one without bodegas, cannot be forecast: 404 SEDE_NOT_MAPPED. */
    async getSede(sedeId) {
      const row = unwrap(await client.from("sugerido_sedes").select("sede_id, nombre, bodegas, activo").eq("sede_id", sedeId).maybeSingle());
      if (!row || !Array.isArray(row.bodegas) || row.bodegas.length === 0) throw notMapped();
      return toSedeDto(row);
    },

    /** One transaction in the database (version = max + 1); the settings snapshot is mandatory. */
    async saveRun({ sedeId, weekStart, method, settings, inputs, flags, warnings, dataAsOf, createdBy, slots }) {
      if (!settings) throw new Error("saveRun requires the settings snapshot");
      if (!Array.isArray(slots) || slots.length === 0) throw new Error("saveRun requires non-empty slots");
      const p_run = {
        sede_id: sedeId,
        week_start: weekStart,
        method,
        settings,
        inputs,
        flags,
        warnings,
        data_as_of: dataAsOf ?? null,
        created_by: createdBy ?? null,
      };
      const p_slots = slots.map((s) => ({
        fecha: s.fecha,
        franja: s.franja,
        forecast_docs: s.forecastDocs,
        forecast_venta: s.forecastVenta,
        required: s.required,
        available: s.available,
        suggested: s.suggested,
        shortfall: s.shortfall,
        status: s.status,
      }));
      const out = unwrap(await client.rpc("sugerido_save_run", { p_run, p_slots }));
      if (!out || !out.id || !Number.isInteger(out.version)) throw unexpected("sugerido_save_run");
      return { id: out.id, version: out.version };
    },

    /** Highest-version run of a sede/week with its slots, or null when none exists. */
    async getLatestRun(sedeId, weekStart) {
      const run = unwrap(
        await client
          .from("sugerido_runs")
          .select("*")
          .eq("sede_id", sedeId)
          .eq("week_start", weekStart)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle(),
      );
      if (!run) return null;
      const slots = unwrap(
        await client.from("sugerido_slots").select("*").eq("run_id", run.id).order("fecha", { ascending: true }).order("franja", { ascending: true }),
      );
      return {
        id: run.id,
        sedeId: run.sede_id,
        weekStart: run.week_start,
        version: run.version,
        method: run.method,
        settings: run.settings,
        inputs: run.inputs,
        flags: run.flags,
        warnings: run.warnings,
        dataAsOf: run.data_as_of,
        createdBy: run.created_by,
        createdAt: run.created_at,
        slots: (slots ?? []).map(toSlot),
      };
    },

    async getOverrides(sedeId, { desde, hasta }) {
      const rows = unwrap(
        await client
          .from("sugerido_overrides")
          .select("*")
          .eq("sede_id", sedeId)
          .gte("fecha", desde)
          .lte("fecha", hasta)
          .order("fecha", { ascending: true })
          .order("franja", { ascending: true }),
      );
      return (rows ?? []).map((o) => ({
        fecha: o.fecha,
        franja: normalizeFranja(o.franja),
        headcount: o.headcount,
        suggestedAtEdit: o.suggested_at_edit ?? null,
        reason: o.reason ?? null,
        updatedBy: o.updated_by ?? null,
        updatedAt: o.updated_at ?? null,
      }));
    },

    /** One transaction in the database. item.value null = remove the override. */
    async applyOverrides({ sedeId, userId, items }) {
      if (items.length === 0) return { upserted: 0, deleted: 0 };
      const p_items = items.map((i) => ({
        fecha: i.fecha,
        franja: i.franja,
        headcount: i.value ?? null,
        suggested_at_edit: i.suggestedAtEdit ?? null,
        reason: i.reason ?? null,
      }));
      const out = unwrap(await client.rpc("sugerido_apply_overrides", { p_sede: sedeId, p_items, p_user: userId }));
      if (!out || !Number.isInteger(out.upserted) || !Number.isInteger(out.deleted)) throw unexpected("sugerido_apply_overrides");
      return { upserted: out.upserted, deleted: out.deleted };
    },
  };
}
