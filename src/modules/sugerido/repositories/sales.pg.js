import { createHttpError } from "../../../shared/http/HttpError.js";
import { normalizeFranja, toEpochDay } from "../domain/dates.js";

const TABLE = "merkahorro_siesa.ventas_pdv_resumen_cajeras";
const QUERY_CANCELED = "57014";

// One row per (fecha, franja) aggregated over ALL bodegas of the sede.
// Invoices without a user are stored as 'sin_cajera': they count as demand, not as a cashier.
const HISTORY_SQL = `
  SELECT fecha::text AS fecha, franja::text AS franja,
         COALESCE(SUM(facturas), 0) AS facturas,
         COALESCE(SUM(devoluciones), 0) AS devoluciones,
         COALESCE(SUM(venta), 0) AS venta,
         count(DISTINCT cajera) FILTER (WHERE cajera IS NOT NULL AND btrim(cajera) <> '' AND lower(btrim(cajera)) <> 'sin_cajera') AS cajeras
    FROM ${TABLE}
   WHERE bodega = ANY($1::text[]) AND fecha >= $2::date AND fecha <= $3::date
   GROUP BY fecha, franja
   ORDER BY fecha, franja`;

// Bounded by the loaded range so recomputing a past week sees that week's data horizon.
const AS_OF_SQL = `SELECT max(fecha)::text AS data_as_of FROM ${TABLE} WHERE bodega = ANY($1::text[]) AND fecha <= $2::date`;

// Physical registers per bodega: distinct `caja` over the 60 days ending at the bodega's latest date
// (bounded by $2 when given, like AS_OF_SQL). 'SIN_CAJA' and blanks are "unknown register", not a register.
// A sede with several bodegas sums its bodegas' counts, since each has its own physical registers.
export const REGISTERS_WINDOW_DAYS = 60;
const REGISTERS_SQL = `
  WITH ref AS (
    SELECT bodega, max(fecha) AS d
      FROM ${TABLE}
     WHERE bodega = ANY($1::text[]) AND ($2::date IS NULL OR fecha <= $2::date)
     GROUP BY bodega)
  SELECT t.bodega::text AS bodega, count(DISTINCT t.caja) AS registers
    FROM ${TABLE} t
    JOIN ref r ON r.bodega = t.bodega
   WHERE t.bodega = ANY($1::text[])
     AND t.fecha > r.d - ${REGISTERS_WINDOW_DAYS} AND t.fecha <= r.d
     AND t.caja IS NOT NULL AND btrim(t.caja::text) <> '' AND upper(btrim(t.caja::text)) <> 'SIN_CAJA'
   GROUP BY t.bodega`;

const invalid = () => createHttpError(502, "Los datos de ventas recibidos no son válidos.", "SALES_DATA_INVALID");

/** Postgres numerics arrive as strings; null/blank/NaN must fail instead of becoming 0. */
function toNumber(value) {
  const blank = value === null || value === undefined || (typeof value === "string" && value.trim() === "");
  const n = blank ? NaN : Number(value);
  if (!Number.isFinite(n)) throw invalid();
  return n;
}

function mapDbError(err) {
  if (err.code === QUERY_CANCELED) {
    return createHttpError(504, "La consulta a la base de datos de ventas excedió el tiempo límite.", "SALES_DB_TIMEOUT");
  }
  return createHttpError(503, "La base de datos de ventas no está disponible.", "SALES_DB_UNAVAILABLE");
}

/** Runs both statements in one READ ONLY transaction; the client is destroyed on failure. */
async function readHistory(pool, { bodegas, desde, hasta }) {
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    const history = await client.query(HISTORY_SQL, [bodegas, desde, hasta]);
    const asOf = await client.query(AS_OF_SQL, [bodegas, hasta]);
    await client.query("COMMIT");
    client.release();
    return { rows: history.rows, dataAsOf: asOf.rows[0]?.data_as_of ?? null };
  } catch (err) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
      client.release(err);
    }
    throw mapDbError(err);
  }
}

/** One READ ONLY statement; the client is destroyed on failure. */
async function readRegisters(pool, { bodegas, hasta }) {
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    const res = await client.query(REGISTERS_SQL, [bodegas, hasta]);
    await client.query("COMMIT");
    client.release();
    return res.rows;
  } catch (err) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
      client.release(err);
    }
    throw mapDbError(err);
  }
}

/** Sales history adapter over the analytics Postgres (read-only, parameterized SQL only). */
export function createSalesRepo(pool) {
  return {
    /**
     * Physical registers per bodega: { [bodega]: count }. A bodega with no usable `caja` is absent.
     * hasta (optional) bounds the reference date like the history load does.
     */
    async loadRegisterCounts({ bodegas, hasta = null }) {
      if (!Array.isArray(bodegas) || bodegas.length === 0 || !bodegas.every((b) => typeof b === "string" && b)) {
        throw new Error("bodegas must be a non-empty array of strings");
      }
      if (hasta !== null) toEpochDay(hasta);
      const rows = await readRegisters(pool, { bodegas, hasta });
      const out = {};
      for (const r of rows) {
        const n = toNumber(r.registers);
        if (!Number.isInteger(n) || n < 0 || typeof r.bodega !== "string") throw invalid();
        out[r.bodega] = n;
      }
      return out;
    },

    /**
     * Shapes consumed by the domain:
     *   slots: { [fecha]: { [HH:MM]: { docs, venta } } }   (docs = facturas + devoluciones)
     *   daily: { [fecha]: docs }
     *   productivityRows: [{ fecha, franja, docs, cajeras }]
     * dataAsOf = latest fecha with data for these bodegas (null when none).
     */
    async loadSlotHistory({ bodegas, desde, hasta }) {
      if (!Array.isArray(bodegas) || bodegas.length === 0 || !bodegas.every((b) => typeof b === "string" && b)) {
        throw new Error("bodegas must be a non-empty array of strings");
      }
      if (toEpochDay(desde) > toEpochDay(hasta)) throw new Error("desde must not be after hasta");

      const { rows, dataAsOf } = await readHistory(pool, { bodegas, desde, hasta });

      const slots = {};
      const daily = {};
      const productivityRows = [];
      try {
        for (const r of rows) {
          toEpochDay(r.fecha);
          const franja = normalizeFranja(r.franja);
          const docs = toNumber(r.facturas) + toNumber(r.devoluciones);
          const venta = toNumber(r.venta);
          const cajeras = toNumber(r.cajeras);
          const day = (slots[r.fecha] ??= {});
          if (franja in day) throw new Error("duplicate slot");
          day[franja] = { docs, venta };
          daily[r.fecha] = (daily[r.fecha] ?? 0) + docs;
          productivityRows.push({ fecha: r.fecha, franja, docs, cajeras });
        }
      } catch (err) {
        throw err.statusCode ? err : invalid();
      }
      return { dataAsOf, slots, daily, productivityRows };
    },
  };
}
