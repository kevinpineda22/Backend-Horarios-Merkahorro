// In-memory fake of the novedades repository port. Written independently of the real
// implementation: filter semantics follow spec R7.3 (overlap: inicio <= end AND fin >= start).

export function createFakeRepo(seed = []) {
  const rows = seed.map((r) => ({
    observacion: null,
    sede_id: null,
    anulada: false,
    anulada_por: null,
    anulada_at: null,
    motivo_anulacion: null,
    created_by: "seed",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_by: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...r,
  }));
  let n = 0;
  const calls = { list: [], insert: [], update: [] };
  const overlaps = (r, desde, hasta) => (!hasta || r.fecha_inicio <= hasta) && (!desde || r.fecha_fin >= desde);

  return {
    rows,
    calls,
    async list(f) {
      calls.list.push(f);
      const out = rows
        .filter((r) => f.incluirAnuladas || !r.anulada)
        .filter((r) => !f.sede || r.sede_id === f.sede)
        .filter((r) => !f.sedeIds || (r.sede_id != null && f.sedeIds.includes(r.sede_id)))
        .filter((r) => !f.sedeNotNull || r.sede_id != null)
        .filter((r) => !f.cedula || r.cedula === f.cedula)
        .filter((r) => !f.tipo || r.tipo === f.tipo)
        .filter((r) => overlaps(r, f.desde, f.hasta))
        .sort((a, b) => (a.fecha_inicio < b.fecha_inicio ? 1 : -1));
      return out.slice(0, f.limit);
    },
    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async findOverlapping({ cedula, desde, hasta, excludeId }) {
      return rows.filter((r) => r.cedula === cedula && !r.anulada && r.id !== excludeId && overlaps(r, desde, hasta));
    },
    async insert(row) {
      calls.insert.push(row);
      const created = {
        observacion: null,
        sede_id: null,
        anulada: false,
        anulada_por: null,
        anulada_at: null,
        motivo_anulacion: null,
        created_at: "2026-10-28T00:00:00.000Z",
        updated_by: null,
        updated_at: "2026-10-28T00:00:00.000Z",
        ...row,
        id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      };
      rows.push(created);
      return created;
    },
    async update(id, patch, { onlyActive = false } = {}) {
      calls.update.push({ id, patch, onlyActive });
      const row = rows.find((r) => r.id === id);
      if (!row || (onlyActive && row.anulada)) return null;
      Object.assign(row, patch);
      return row;
    },
  };
}

export const ID_A = "11111111-1111-4111-8111-111111111111";
export const ID_B = "22222222-2222-4222-8222-222222222222";
export const ID_C = "33333333-3333-4333-8333-333333333333";
