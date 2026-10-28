import "dotenv/config";
import app from "./app.js";
import { getEnv } from "./config/env.js";

const env = getEnv(); // fail fast on a bad configuration

// On Vercel the file is imported as a serverless function: do NOT listen there.
if (env.NODE_ENV !== "production") {
  app.listen(env.PORT, () => {
    console.log(`Backend Horarios Merkahorro listening on :${env.PORT} (${env.NODE_ENV})`);
  });
}

export default app;
