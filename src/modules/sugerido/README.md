# sugerido (cashier headcount suggestion)

Suggests how many cashiers each sede needs per 15-minute slot, per day, for a Monday-start week,
compares it with the cashiers available, and lets a planner override single slots. Overrides live
apart from the suggestion and survive a recompute.

## Layout

- `domain/` - pure functions, no I/O; the clock is always injected (`bogotaToday(now)`).
  Dates and slots, Colombian holidays (`calendar`), demand `forecast`, `productivity`, `headcount`,
  `absences`, `availability`, `merge` (suggested / override / final), `freshness`, `weekRange`.
- `repositories/` - ports and adapters, every client injected so tests use fakes:
  `sales.pg` (analytics Postgres), `settings.supabase`, `suggestions.supabase` (sedes, runs, overrides),
  `staff.port` (cashier pool), `absences.port` (novedades).
- `sugerido.service.js` - use cases (`computeRun`, `getWeek`, `saveOverrides`, `listSedes`).
  Sources run together; if one fails the whole run fails (an unavailable pool is never an empty pool).
- `sugerido.schemas.js` - zod schemas for params and the overrides body.
- `sugerido.routes.js` - `createSugeridoRouter({ authenticate, accessRepo, service })`.
  Per route: authenticate, load access, role, validate, sede scope.

## Endpoints (`/api/sugerido`)

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/sedes` | admin, planner, viewer | Active sedes the caller may see. |
| GET | `/sedes/:sedeId/weeks/:weekStart` | admin, planner, viewer | Latest run + overrides. 200 with an empty state when no run exists. |
| POST | `/sedes/:sedeId/weeks/:weekStart/runs` | admin, planner | Recomputes and saves a new run version (201). Without any sales history it answers 200 with zeros and `persisted: false`. Responds with the run it saved. |
| PUT | `/sedes/:sedeId/weeks/:weekStart/overrides` | admin, planner | Array of `{ fecha, franja, value }`; `value: null` removes the override. |

`weekStart` must be a Monday between 53 weeks back and 12 weeks ahead of the current week (Bogota).
An override on a slot the run did not suggest is accepted (stored with `suggestedAtEdit: null`) and
shown with `suggested: null`.

## Errors

JSON `{ ok, error, code }` (messages in Spanish).

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad week, franja, value, duplicate or out-of-week date. |
| 400 | `WEEK_OUT_OF_RANGE` | Week outside the allowed window. |
| 401 | - | Missing or invalid token. |
| 403 | `FORBIDDEN_ROLE`, `FORBIDDEN_SEDE` | Role or sede scope not allowed. |
| 404 | `SEDE_NOT_MAPPED` | Unknown or inactive sede. |
| 409 | `NO_RUN` | Overrides on a week with no saved run. |
| 502/503/504 | upstream codes (`STAFF_SOURCE_UNAVAILABLE`, `SALES_DB_UNAVAILABLE`, `SALES_DB_TIMEOUT`) | A source failed; nothing is saved. |

## Not done yet

Settings routes and mounting `/sugerido` in `src/routes.js` (unit 4b). See `docs/HANDOFF.md`.
