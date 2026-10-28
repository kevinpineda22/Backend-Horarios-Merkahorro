/** Central error handler: always answers with the same JSON shape. */
export function errorHandler(err, _req, res, _next) {
  // Postgres query_canceled (statement_timeout) -> gateway timeout, safe message.
  if (err.code === "57014") {
    console.error("Error:", err.message);
    return res.status(504).json({
      ok: false,
      error: "La consulta a la base de datos de ventas excedió el tiempo límite",
      code: "SALES_DB_TIMEOUT",
    });
  }

  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) console.error("Error:", err.message);

  res.status(statusCode).json({
    ok: false,
    error: err.expose ? err.message : "Error interno del servidor",
    // Only app-level codes of exposed errors; never SQLSTATE/Node codes on 500.
    ...(err.expose && err.code && { code: err.code }),
    ...(err.expose && err.details && { details: err.details }),
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
}
