import express from "express";
import helmet from "helmet";
import morgan from "morgan";

import defaultRoutes from "./routes.js";
import { corsMiddleware } from "./config/cors.js";
import { notFound } from "./shared/http/notFound.js";
import { errorHandler } from "./shared/http/errorHandler.js";

/**
 * Builds the Express app without listening, so tests can import it.
 * `routes` defaults to the production router; tests inject one built with fakes.
 */
export function createApp({ routes = defaultRoutes } = {}) {
  const app = express();

  app.use(helmet());
  app.use(corsMiddleware);
  // Every answer depends on the signed-in user (and on the CORS origin). Vercel's default
  // "public, max-age=0, must-revalidate" let a browser reuse a stored answer from another origin,
  // which then failed CORS and read as a network error ("No pudimos cargar las novedades").
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  if (process.env.NODE_ENV !== "test") app.use(morgan("dev"));
  app.use(express.json({ limit: "2mb" }));

  app.use("/api", routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp();
