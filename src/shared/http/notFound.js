/** 404 for any route no module claimed. */
export function notFound(req, res) {
  res.status(404).json({
    ok: false,
    error: "Ruta no encontrada",
    method: req.method,
    path: req.originalUrl,
  });
}
