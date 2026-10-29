# Backend Horarios Merkahorro

REST API for the Merkahorro shift-scheduling system. Consumed by the React
frontend (`src/pages/horarios_merkahorro` in Pagina-web_React).

**Status: structure only.** No business logic yet. The first feature, `sugerido`
(suggested cashier schedule), is waiting on the business definition; see
`src/modules/sugerido/README.md`.

## Stack

Express 4, ESM, dotenv, helmet, cors, morgan, zod, `@supabase/supabase-js`,
`node --test`. Deployed on Vercel (entry `api/index.js`, configured via `functions` in `vercel.json`).

## Structure

```
src/
  server.js          starts the app locally (does not listen on Vercel)
api/index.js         Vercel serverless entry; exports the app
  app.js             builds the Express app (importable by tests)
  routes.js          mounts domain modules under /api
  config/            env.js (zod, lazy) and cors.js (env-driven allowlist)
  shared/
    supabase.js      lazy service-role client
    http/            HttpError, errorHandler, notFound, authSupabase
  modules/
    health/          GET /api/health (public)
    sugerido/        README only, pending business definition
test/
```

### Domain-folder rule

Code is organized by DOMAIN, not by technical layer. Each feature lives in
`src/modules/<domain>/` with its own routes, validators, services and tests.
Only code used by two or more domains goes to `src/shared/`. Do not create
top-level `controllers/`, `services/` or `routes/` folders.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | `node --watch src/server.js` |
| `npm start` | `node src/server.js` |
| `npm test` | `node --test` (runs offline, no credentials needed) |

## Environment variables

See `.env.example`. Copy it to `.env` and fill in real values (never commit it).

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | no | `development` (default), `test`, `production` |
| `PORT` | no | Default `3003` |
| `SUPABASE_URL` | yes | Same Supabase project as the main app |
| `SUPABASE_SERVICE_KEY` | yes | Secret. Server-side only |
| `TRAZABILIDAD_URL` | no | Base URL of backend-trazabilidad (employee directory source). Without it `/api/empleados` answers 503 `STAFF_SOURCE_UNAVAILABLE` |
| `TRAZABILIDAD_SERVICE_KEY` | no | Secret. Sent as `x-api-key` to the trazabilidad service endpoint; must match one of its `SERVICE_API_KEYS` |
| `CORS_ORIGINS` | no | Comma-separated allowlist. Empty uses the defaults (production domains + `http://localhost:5173/5174`) |

The environment is validated on first use and the server fails fast with a list
of invalid variables. In `NODE_ENV=test` the Supabase variables get offline defaults.

## How the frontend authenticates

The frontend signs in with Supabase and sends the access token (stored in
`localStorage` as `token`) on every call:

```
Authorization: Bearer <Supabase access token>
```

Protected routes use `authenticate` from `src/shared/http/authSupabase.js`, which
verifies the token with `supabase.auth.getUser(token)` and sets
`req.user = { id, email }`. Error codes: `AUTH_REQUIRED` (401), `AUTH_INVALID`
(401), `AUTH_UNAVAILABLE` (503). `/api/health` is public.

Error messages returned to clients are in Spanish; code, logs and docs are in English.
