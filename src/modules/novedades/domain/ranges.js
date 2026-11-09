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
    subtipo: row.subtipo ?? null,
    detalles: row.detalles ?? {},
    sedeId: row.sede_id ?? null,
    sedeNombre: row.sede_nombre ?? null,
    responsableNombre: row.responsable_nombre ?? null,
    // Storage paths are internal: clients only learn whether a file exists and fetch it by signed URL.
    hasAdjunto: Boolean(row.adjunto_path),
    hasFirma: Boolean(row.firma_path),
    hasHistoria: Boolean(row.historia_path),
    hasSoporte: Boolean(row.soporte_path),
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
