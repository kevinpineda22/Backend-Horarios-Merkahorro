/** Inclusive range overlap over 'YYYY-MM-DD' strings (lexicographic order == date order). */
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && aEnd >= bStart;
}

/** Maps a `novedades` row (snake_case) to the public camelCase shape. */
export function toNovedadDto(row) {
  return {
    id: row.id,
    cedula: row.cedula,
    tipo: row.tipo,
    fechaInicio: row.fecha_inicio,
    fechaFin: row.fecha_fin,
    observacion: row.observacion ?? null,
    sedeId: row.sede_id ?? null,
    anulada: row.anulada ?? false,
    anuladaPor: row.anulada_por ?? null,
    anuladaAt: row.anulada_at ?? null,
    motivoAnulacion: row.motivo_anulacion ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at ?? null,
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at ?? null,
  };
}
