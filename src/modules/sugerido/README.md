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
- `sugerido.schemas.js` - zod schemas for params, the overrides body and the settings patch.
- `sugerido.routes.js` - `createSugeridoRouter({ authenticate, accessRepo, service })`.
  Per route: authenticate, load access, role, validate, sede scope.
- `sugerido.module.js` - composition: `createSugeridoModule({ authenticate, accessRepo, client, empleadosService, getPool })`.
  Mounted by `src/routes.js` at `/sugerido`. Nothing connects at import: Supabase and the pg pool are created on first use,
  and the staff port reads the same `empleadosService` instance as `/empleados` (one shared directory cache).

## Endpoints (`/api/sugerido`)

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/settings` | admin | Global parameters (`ordinaryWeeklyHours`, `overtimeWeeklyHours`, `dailyMaxHours`, `utilization`, `maxWorkingDaysPerWeek`, `minCashiers`, `staleAfterDays`, `blockingAbsenceTypes`) plus `updatedBy` / `updatedAt`. |
| PUT | `/settings` | admin | Partial update, at least one key. Ranges: `utilization` in [0.1, 1]; hours > 0 (weekly <= 168, daily <= 24); `maxWorkingDaysPerWeek` 1..7; `minCashiers` 0..100; `staleAfterDays` 0..365; `blockingAbsenceTypes` a subset of the six novedad tipos. Unknown keys are dropped. 400 leaves the stored values untouched. Applies to the NEXT run; past runs keep their snapshot. |
| GET | `/sedes` | admin, planner, viewer | Active sedes the caller may see. |
| GET | `/sedes/:sedeId/weeks/:weekStart` | admin, planner, viewer | Latest run + overrides. 200 with an empty state when no run exists. |
| POST | `/sedes/:sedeId/weeks/:weekStart/runs` | admin, planner | Recomputes and saves a new run version (201). Without any sales history it answers 200 with zeros and `persisted: false`. Responds with the run it saved. |
| PUT | `/sedes/:sedeId/weeks/:weekStart/overrides` | admin, planner | Array of `{ fecha, franja, value }`; `value: null` removes the override. |

`weekStart` must be a Monday between 53 weeks back and 12 weeks ahead of the current week (Bogota).
An override on a slot the run did not suggest is accepted (stored with `suggestedAtEdit: null`) and
shown with `suggested: null`.

## Response shape notes

- A slot has `suggested`, `required`, `available`, `shortfall`, `override`, `final` and `difference`. Orphan slots (a planner override on a
  slot the run did not suggest) carry `suggested`, `required`, `available`, `shortfall` and `difference` as `null`; `final` equals the override.
  Slots of a day are ordered by `franja` and never duplicated.
- `capacity` reports the weekly hours picture (`requiredH`, `ordinaryCapH`, `maxCapH`, `overtimeNeeded`, `weeklyShortfall`). Slot headcounts are not trimmed by
  hours; a demand above 42 + 12 h per cashier shows up as `weeklyShortfall`.
- POST saves the run and then reads it back by id. If the read-back fails after the save, the POST answers 500 although the run IS persisted:
  the client should re-GET the week instead of recomputing (a recompute would create another version).

## Runtime configuration

| Variables | Needed by | When missing |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | every endpoint | Fails on first use (500), same as the other modules. |
| `POSTGRES_HOST`, `POSTGRES_DATABASE`, `POSTGRES_USER`, `POSTGRES_PASSWORD` (`POSTGRES_PORT`, `POSTGRES_SSL` false/unset, `POSTGRES_STATEMENT_TIMEOUT_MS` default and max 8000; connect timeout 5 s, both under Vercel's 30 s) | `POST .../runs` (sales history) | 503 `SALES_DB_UNAVAILABLE` at request time. Other endpoints keep working. |
| `TRAZABILIDAD_URL`, `TRAZABILIDAD_SERVICE_KEY` (`EMPLEADOS_CACHE_TTL_MS`) | `POST .../runs` (cashier pool) | 503 `STAFF_SOURCE_UNAVAILABLE`; never an empty pool. |

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

Frontend panel and settings form (F2c) and the backtest (unit 6). See `docs/HANDOFF.md`.
