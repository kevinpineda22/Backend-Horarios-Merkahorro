import { createHttpError } from "../../shared/http/HttpError.js";

const TABLE = "employee_loans";
const COLUMNS = "id, cedula, home_sede_id, host_sede_id, week_start, motivo, created_by, created_at";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
// Migration 016 not applied yet: Postgres 42P01 (undefined_table), PostgREST PGRST205 (table not in the schema cache).
const isMissingTable = (error) => error?.code === "42P01" || error?.code === "PGRST205";

const toDto = (r) => ({
  id: r.id,
  cedula: r.cedula,
  homeSedeId: r.home_sede_id,
  hostSedeId: r.host_sede_id,
  weekStart: r.week_start,
  motivo: r.motivo ?? null,
  createdBy: r.created_by,
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
});

/** Thrown by create() when the (cedula, week) already has an ACTIVE loan; the service maps it to 409 LOAN_EXISTS. */
export class LoanExistsError extends Error {
  constructor() {
    super("An active loan already exists for this cedula and week");
    this.name = "LoanExistsError";
  }
}

/** Thrown by create() when a sede is not in sugerido_sedes (it disappeared after the check). */
export class LoanSedeMissingError extends Error {
  constructor() {
    super("Sede is not in sugerido_sedes");
    this.name = "LoanSedeMissingError";
  }
}

/**
 * Employee loans between sedes over `employee_loans` (migration 016). Soft revoke: a row is never deleted, so the table
 * is its own history. At most one ACTIVE row (revoked_at null) per (cedula, week_start), enforced by the DB.
 */
export function createEmployeeLoansRepo(client, { now = () => new Date(), logger = console } = {}) {
  let warned = false;

  /**
   * Reads that feed schedule saves and the sugerido degrade to "no loans" while migration 016 is missing (warning once);
   * any other database error keeps failing closed.
   */
  function degradeIfMissing(error) {
    if (!isMissingTable(error)) throw error;
    if (!warned) {
      warned = true;
      logger?.warn?.("[empleados] employee_loans is missing (apply migration 016); answering without loans");
    }
    return [];
  }

  /** Writes and single lookups never degrade: the loan feature is unavailable until the migration is applied. */
  function failIfMissing(error) {
    if (isMissingTable(error)) {
      throw createHttpError(503, "Los préstamos entre sedes aún no están disponibles. Inténtalo más tarde.", "LOANS_UNAVAILABLE");
    }
    throw error;
  }

  const active = () => client.from(TABLE).select(COLUMNS).is("revoked_at", null);

  async function findActive(cedula, weekStart) {
    const { data, error } = await active().eq("cedula", cedula).eq("week_start", weekStart).maybeSingle();
    if (error) failIfMissing(error);
    return data ? toDto(data) : null;
  }

  return {
    /** Every active loan of the week, in ONE query. */
    async listActiveByWeek(weekStart) {
      const { data, error } = await active().eq("week_start", weekStart).order("created_at", { ascending: true });
      if (error) return degradeIfMissing(error);
      return (data ?? []).map(toDto);
    },

    /** Active loans of the week whose home sede is `sedeId` and whose cedula is one of `cedulas`. */
    async listActiveLentOut({ sedeId, weekStart, cedulas }) {
      if (!cedulas.length) return [];
      const { data, error } = await active().eq("week_start", weekStart).eq("home_sede_id", sedeId).in("cedula", cedulas);
      if (error) return degradeIfMissing(error);
      return (data ?? []).map(toDto);
    },

    /** The ACTIVE loan with this id, or null (unknown and already revoked are indistinguishable). */
    async findActiveById(id) {
      const { data, error } = await active().eq("id", id).maybeSingle();
      if (error) failIfMissing(error);
      return data ? toDto(data) : null;
    },

    findActive,

    /** Inserts the active row. LoanExistsError when the person already has one that week. */
    async create({ cedula, homeSedeId, hostSedeId, weekStart, motivo, userId }) {
      const { data, error } = await client
        .from(TABLE)
        .insert({ cedula, home_sede_id: homeSedeId, host_sede_id: hostSedeId, week_start: weekStart, motivo: motivo ?? null, created_by: userId })
        .select(COLUMNS)
        .single();
      if (error?.code === UNIQUE_VIOLATION) throw new LoanExistsError();
      if (error?.code === FK_VIOLATION) throw new LoanSedeMissingError();
      if (error) failIfMissing(error);
      return toDto(data);
    },

    /** Soft-revokes the ACTIVE loan. The revoked loan, or null when it did not exist / was already revoked. */
    async revoke({ id, userId }) {
      const { data, error } = await client
        .from(TABLE)
        .update({ revoked_by: userId, revoked_at: now().toISOString() })
        .eq("id", id)
        .is("revoked_at", null)
        .select(COLUMNS);
      if (error) failIfMissing(error);
      return data?.length ? toDto(data[0]) : null;
    },
  };
}
