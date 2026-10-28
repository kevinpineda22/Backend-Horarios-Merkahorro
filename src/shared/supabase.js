import { createClient } from "@supabase/supabase-js";
import { getEnv } from "../config/env.js";

let client = null;

/** Service-role client, created on first use (never at import time). Server-side only. */
export function getSupabase() {
  if (!client) {
    const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = getEnv();
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}
