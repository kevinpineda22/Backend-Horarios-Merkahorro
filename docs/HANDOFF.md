# Handoff: Horarios Merkahorro — cashier suggestion (`sugerido-cajeras`)

Status as of **2026-10-29**. The backend is ~85% done, units 1–3b are on `main`, unit 4a is written and under review on a local branch, and the frontend panel (F2) is the last big block. Read **Quick path** first; everything else is reference.

## Quick path (how to continue)

1. **Read the rules** in [Working agreement](#working-agreement). They are user preferences, not suggestions.
2. **Finish unit 4a.** It lives on local branch `feat/sugerido-api` in Backend-Horarios (uncommitted, 435/435 tests).
   - A fresh review was running when this was written. Re-run it if you don't have its verdict.
   - Known issue to check first: the service reads **420 days** of sales, but `forecast.js` looks back **730 days** for holidays. Derive the window from the domain constants instead of a magic number.
   - Then: commit → fast-forward `main` → `git push origin main`.
3. **Unit 4b** (tasks 4.3–4.4): settings routes + mount `/sugerido` in `src/routes.js` + end-to-end integration test with fakes.
4. **Unit F2** (frontend, branch `juan`, user pushes): F2a directory, F2b Accesos screen, F2c sugerido panel + settings form.
5. **Unit 6**: manual backtest (WAPE ≤ 20% at sede × hour).
6. Close SDD: `sdd-verify`, then `sdd-archive`.

Expected result: a "Sugerido" panel in Programación that shows required vs. available cashiers per 15-min slot, lets an admin edit cells, and keeps both values.

## What the feature is

| Item | Decision |
|---|---|
| v1 output | **Headcount** of cashiers per sede, per day, per 15-min slot (option A). Per-person shifts (option B) come later. |
| Demand | Forecast from `merkahorro_siesa.ventas_pdv_resumen_cajeras` (analytics Postgres): blend of last 4 same-day-type dates and year-ago with 28-day trend. |
| Headcount | `required = max(minCashiers, ceil(smoothedDocsPerHour / (productivity × utilization)))`, productivity = sede's own historical pace (busiest 20% of slots, 56 days). |
| Availability | Cashier pool − novedades (absences) − 1 rest day/week, within 42 h ordinary + 12 h overtime. |
| Admin edits | Overrides stored separately from the suggestion; they survive recompute. |
| Settings | Editable in DB (`sugerido_settings`), not env vars. Each run snapshots them. |

## Business rules (confirmed by the user)

| Rule | Value |
|---|---|
| Weekly hours | **42 ordinary + max 12 overtime** (Ley 2101). Daily max 10 h and utilization 0.85 are editable defaults. |
| Sedes in scope | **Only the 7 supermarkets** (butcher shops excluded). |
| Cashier cargos | **Exact allowlist**: `CAJERA`, `CAJERO`, `CAJERO - SURTIDOR`. `CAJERO PAC` is excluded. No substring matching. |
| Cédula | Same rule as backend-trazabilidad `normalizarCedula`: digits only, strip leading zeros (keep if all zeros), then 5–15 digits; all-zeros rejected in novedades. |
| Absence types | Vacaciones, Incapacidades, Licencias, Permisos, Estudio, Día de la Familia (NFC). Which ones block is a setting. |
| Restrictions | Leaders see only `restriccion_operativa` (HR-written, no diagnosis). The free-text `restricciones` (Ley 1581) never leaves HR. |
| Failures | Never return an empty list or "no restriction" because a source failed. Fail with 503/502. |

### Sede catalog (seeded and verified in Supabase)

| sede_id | Bodegas (sales) | Trazabilidad alias |
|---|---|---|
| copacabana | PV001 | PRINCIPAL COPACABANA |
| girardota-parque | 00301 | SEDE GIRARDOTA PARQUE |
| villahermosa | 00201, PV002 | SEDE VILLAHERMOSA |
| barbosa | 00701 | SEDE MERKAHORRO BARBOSA |
| girardota-llano | 00401 | SEDE GIRARDOTA LLANO |
| san-juan | 00801 | SEDE MERKAHORRO SAN JUAN |
| las-vegas | 00601 | SEDE COPACABANA LAS VEGAS |

`SEDE CARNES BARBOSA` must **not** map to `barbosa`.

## Repositories and state

| Repo | Path | Branch / policy | State |
|---|---|---|---|
| Backend-Horarios (this repo) | `C:\Users\juan.isaza\Desktop\BACKENDS\Backend-Horarios-Merkahorro` | `main` → push directly after fresh review (no PRs) | `main` at `34ca805`, pushed. 4a on local `feat/sugerido-api`. |
| Frontend | `C:\Users\juan.isaza\Desktop\merkaPage\Pagina-web_React` | commit on `juan`; **the user pushes**; stage only feature files | `72b8022d`, `61bd8c5d`, `cec31fa7` (not pushed by us). |
| backend-trazabilidad | `C:\Users\juan.isaza\Desktop\BACKENDS\Trazabilidad-Backend\backend-trazabilidad` | **production**; local branch only, never push/deploy | `feat/service-empleados-activos`: `bed0512`, `d64e820` (from `origin/main` 25a7572). |

### Backend-Horarios commits on `main`

| Commit | Unit | Content |
|---|---|---|
| 2634d93 | 1 | Foundation (asyncHandler, validate, pg pool, Vercel `api/index.js`) + migration 001 |
| c0ea2eb | 2a | Dates, Colombian holidays, forecast |
| 841f581 | 2b | Productivity, headcount, absences, availability, merge, freshness |
| 89c9e33 | 3a-i | Migration 002 novedades + shared `authorize.js` |
| ba16408, fb5faac | 3a-ii | Novedades module + `/api/novedades` |
| 6711951 | C1 | Shared `src/shared/cedula.js` |
| e6b4b56, 3616369 | AC | Migration 003 (access audit, soft revoke, LAST_ADMIN RPCs, sede aliases) + `/api/accesos` |
| 88c7c57, 06c94ce | E | `/api/empleados` (trazabilidad service client, frozen 5-min cache) |
| ee7cde0 | fix | `POSTGRES_SSL` defaults to false (sales server rejects SSL) |
| 3ef63bd | seed | `db/seeds/sugerido_sedes.sql` |
| 1536bf3, 34ca805 | 3b | Sugerido adapters (sales pg, settings, suggestions, staff port, absences port) |

### Supabase (horarios project) — applied by the user

`001_sugerido.sql`, `002_novedades.sql`, `003_accesos.sql`, `db/seeds/sugerido_sedes.sql`. Bootstrap admin: user `4c706a1c-63af-465b-9342-e9fb62b9ac38` (juanmerkahorro@gmail.com), role `admin`, `sede_ids = null`.

### Environment variables (names only — never commit values)

| Where | Variable | Notes |
|---|---|---|
| Backend-Horarios | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Required. |
| Backend-Horarios | `POSTGRES_HOST/PORT/DATABASE/USER/PASSWORD` | Sales DB. `POSTGRES_SSL` must be false/unset. |
| Backend-Horarios | `TRAZABILIDAD_URL`, `TRAZABILIDAD_SERVICE_KEY` | Needed once trazabilidad's branch is deployed. Key = same secret as in trazabilidad, without the `horarios:` prefix. |
| Backend-Horarios | `EMPLEADOS_CACHE_TTL_MS` | Optional, default 300000. |
| Trazabilidad | `SERVICE_API_KEYS` | `horarios:<64-hex secret>` (user generates it locally). |
| Frontend | `VITE_BACKEND_HORARIOS_MERKAHORRO_URL` | Default `http://localhost:3003/api`. Do NOT reuse `VITE_BACKEND_HORARIOS_URL` (retired scheduler). |

Backend-Horarios runs locally on **:3003** (`npm run dev`).

## Remaining work

| Unit | Tasks | Notes |
|---|---|---|
| 4a | 4.1–4.2 | On `feat/sugerido-api`; finish review (see Quick path). Decisions taken: GET with no run → 200 empty state; POST with no history → 201 zeros, `persisted:false`. |
| 4b | 4.3 settings routes (admin GET/PUT), 4.4 integration test + mount `/sugerido` in `src/routes.js` (lazy pg pool and Supabase, no network at import) | |
| F2a | Trabajadores/Programación use `/api/empleados`; drop email/phone UI; key rows by cédula; show `restriccionOperativa`; delete `useEmployeeRestrictions` | Frontend |
| F2b | Accesos screen (admin): list/create/update/revoke, user lookup, LAST_ADMIN messages | Frontend |
| F2c | Sugerido API client + hook; DEMAND panel in `components/ScheduleView.jsx`; editable cells → overrides; `SugeridoSettingsForm` | Frontend |
| 6 | Backtest script, WAPE ≤ 20% at sede × hour | Manual |

Full task list with file names: Engram `sdd/sugerido-cajeras/tasks` (see below).

## Deployment order (when the user decides to ship)

1. Supabase (trazabilidad project): run `sql/restricciones_operativas.sql` **before** deploying trazabilidad.
2. Trazabilidad: set `SERVICE_API_KEYS`, push `feat/service-empleados-activos` explicitly (`git push -u origin feat/service-empleados-activos`; its upstream is `origin/main`), merge, deploy.
3. Backend-Horarios: set env vars in Vercel, deploy `main`.
4. Frontend: user pushes `juan`. The HR operational-restriction field hides itself if trazabilidad is not updated yet.

## Working agreement

- **Language:** code, comments, commits, docs in English. UI copy in Spanish (existing UI language). Talk to the user in Rioplatense Spanish.
- **Commits:** conventional commits, **never** `Co-Authored-By` or AI attribution.
- **Strict TDD:** observe the specific assertion fail (RED) before implementing. A "module not found" error is not RED.
- **Before every commit:** fresh-context review + mutation testing. Fix CRITICAL/WARNING findings, re-verify, then commit.
- **Mutation testing:** back up files by copying and verify checksums. **Never** `git checkout -- <file>`, `git restore`, `git stash` or `git reset` (one agent wiped its own work that way).
- **Artifacts in Engram:** when updating `tasks` or `apply-progress`, read the full text and write it back in full. Never summarize or drop earlier content.
- **Secrets:** Claude cannot read `.env*` (permission). Never print credentials.
- **Databases:** read-only queries only, inside `BEGIN READ ONLY … ROLLBACK`, via the repo's `getPool()` (`POSTGRES_SSL=false`). Never run `siesa-pos-sync` (writes to production Siesa).
- **Frontend:** only touch `src/pages/horarios_merkahorro/**`, `src/routes/RouterApp.jsx` and the HR restrictions editor; `@testing-library` is not installed, so keep logic in tested pure helpers.
- **Tests:** `npm test` in Backend-Horarios (not `node --test test/`, which crashes); `npm test` (vitest) in the frontend and trazabilidad.

## Lessons learned (avoid repeating)

| Lesson | Where it bit us |
|---|---|
| Tests written by the implementer can lock in the bug | null-sede privilege escalation; `count(DISTINCT cajera)` |
| Paginate until an **empty** page, never a short page | trazabilidad restrictions, novedades overlap |
| Verify agents' claims against code | "backend returns snake_case" was false |
| Check the source system before ordering a rule | cédula leading zeros |
| Shared in-memory caches must return frozen data | empleados directory |
| Check real data before claiming impact | `sin_cajera` had 0 rows in all history |
| `ilike` treats `_` and `%` as wildcards | accesos user lookup |
| Exact allowlists beat substring rules | cashier cargos |

## Open questions / follow-ups

- **Sales freshness:** latest sales date seen was 2026-10-27 on 2026-10-29 (2 days old) — check the daily sync.
- **Security (out of scope, flagged):** `AsignarEquipo.jsx` updates `profiles` from the browser. Audit `profiles` RLS for role self-escalation.
- Accepted race: concurrent PATCH on accesos (LAST_ADMIN invariant is still enforced inside the RPC).
- Concurrent recomputes of the same sede/week both save (versions N and N+1, serialized by an advisory lock); each POST returns its own run, but GET shows the highest version, so the last writer wins on screen.

## Where the full context lives (Engram, project `juan.isaza`)

Search with `mem_search` (use `all_projects: true` if needed), then `mem_get_observation`.

| Topic key | What |
|---|---|
| `sdd/sugerido-cajeras/proposal` | Proposal (+ amendment) |
| `sdd/sugerido-cajeras/spec` | Spec v5, 13 capabilities |
| `sdd/sugerido-cajeras/design` | Design rev 6 |
| `sdd/sugerido-cajeras/tasks` | Task checklist with authoritative resolutions R-a…R-i |
| `sdd/sugerido-cajeras/apply-progress` | Implementation log (partly summarized by an earlier agent) |
| `sdd/sugerido-cajeras/delivery` | Latest delivery status |
| `sdd/sugerido-cajeras/sede-catalog`, `cashier-cargos`, `labor-limits`, `settings-decision`, `novedades-decision`, `access-decision`, `cedula-and-restrictions` | Business decisions |
| `architecture/merkahorro-user-admin-auth` (project `pagina-web_react`) | How users, roles and sedes work today |

## STATUS UPDATE (2026-10-29, after the 4a fix pass) - read this first

- **Unit 4a is code-complete and uncommitted** on `feat/sugerido-api`: **449/449** tests (`npm test`). The orchestrator commits after a fresh review, then fast-forwards `main` and pushes.
- Applied fixes: derived lookback window; `AS_OF_SQL` bounded by `fecha <= $2`; no-history POST is 200 with zeros, `noHistory` and `persisted:false`; PUT overrides without a run is 409 `NO_RUN`; franja mutant-killer tests (`:05/:14/:50/:59` rejected, `00:00` and `23:45` valid; mutants `[0-5]0` and `([0-5]0|15|30|45)` are killed).
- `weekStart` is bounded to 53 weeks back .. 12 weeks ahead of the current Monday (`domain/weekRange.js`), else 400 `WEEK_OUT_OF_RANGE` on GET, POST and PUT.
- POST composes its response from the run id returned by `sugerido_save_run` (new repo method `getRunById`), not from "latest", so concurrent recomputes no longer return each other's run.
- Overrides on a slot with no suggestion are accepted on purpose (a planner may add coverage outside the historical pattern): stored with `suggestedAtEdit: null` and returned as a slot with `suggested: null`, `final = override`.
- The sales lookback deliberately omits the "+7 days" once listed here: every reference date (holiday, same-day-type, year-ago, trend, productivity) is before `weekStart`, so the window is `weekStart - max(lookbacks)` .. `weekStart + 6`.
- **Remaining for 4b:** settings routes (admin GET/PUT), mount `/sugerido` in `src/routes.js` with lazy pg pool and Supabase (no network at import), end-to-end integration test with fakes. Then F2 (frontend), unit 6 (backtest), `sdd-verify`, `sdd-archive`.
- Engram `sdd/sugerido-cajeras/apply-progress` (#580) was truncated by an earlier agent. Treat `tasks` (#579), `delivery` (#581), git history and this file as the source of truth.
- This file is **not committed yet**. Commit it with unit 4a.

## STATUS UPDATE 2 (2026-10-29, unit 4b done) - latest

- **Unit 4b is code-complete and uncommitted** on `feat/sugerido-api` (on top of 4a `c1e7853` and this handoff `c7a6728`): **476/476** tests (`npm test`). Needs a fresh review, then commit, fast-forward `main`, push.
- **4.3 settings:** admin-only `GET /api/sugerido/settings` and `PUT /api/sugerido/settings` (same router as the rest; order authenticate, loadAccess, requireRole admin, validate). Partial patch, zod ranges, unknown keys dropped, 400 keeps the stored value, next run uses it, past runs keep their snapshot.
- **4.4 mount:** `src/modules/sugerido/sugerido.module.js` composes the module; `src/routes.js` mounts it at `/sugerido` with the SAME `empleadosService` as `/empleados` (one cache). Pool and Supabase are lazy: importing the app opens no pg pool (guarded by `test/sugerido/import-no-pool.test.js`).
- Missing `POSTGRES_*` is 503 `SALES_DB_UNAVAILABLE` on `POST .../runs`; missing `TRAZABILIDAD_*` is 503 `STAFF_SOURCE_UNAVAILABLE`; neither crashes boot.
- New tests: `settings.routes.test.js`, `wiring.test.js`, `import-no-pool.test.js`, `integration.test.js` (HTTP end to end with fakes); two review leftovers in `service.test.js` (Bogota/UTC week boundary, orphan override ordering). Slot sort now uses a plain string comparison.
- Gotcha: slot headcounts are not trimmed by weekly hours. The 42 + 12 h cap shows up in `capacity` (`weeklyShortfall`, `overtimeNeeded`), not per slot.
- **Remaining:** F2b (Accesos screen), F2c (sugerido panel and settings form), unit 6 (backtest), `sdd-verify`, `sdd-archive`. F2a is already committed on the frontend branch `juan` (affb7c86).

## STATUS UPDATE 3 (2026-10-29, unit F2c done) - latest

- **F2c is code-complete and uncommitted** on the frontend branch `juan` (on top of F2a `affb7c86`). `npx vitest run src/pages/horarios_merkahorro`: **211 tests, 13 files, all green**; `npx eslint src/pages/horarios_merkahorro` clean. Needs a browser check and a fresh review before the commit.
- **F2.4:** `api/sugeridoApi.js` (listSedes, getWeek, runSuggestion, saveOverrides as a bare array with `value: null` to remove, getSettings, updateSettings), `hooks/useSugerido.js` (latest-response guard for loads, in-flight guard for POST), `utils/sugerido.js` (error copy for every code in the README, week analytics), `utils/sugeridoFlows.js` (a POST that answers 500 re-reads the week instead of recomputing).
- **Sede names:** `GET /sugerido/sedes` now feeds the labels through `hooks/useSedeNames.js`; the hardcoded `SEDE_LABELS` is gone. If the call fails the slug is shown, so Trabajadores and Programación keep working.
- **F2.5:** `ScheduleView` lost the mock `DEMAND` chart, KPI cards and "Aplicar sugerido" banner; `components/SugeridoPanel.jsx` + `SugeridoDayDetail.jsx` show status bar, real KPIs, a day x hour heatmap (max `final` per hour) and the 15-minute table with batched overrides (one PUT per day). The hardcoded "Horario del negocio" chip was removed from `HorariosShell`.
- **F2.6:** `components/SugeridoSettingsForm.jsx` (modal, ranges mirror the backend, `utils/sugeridoSettings.js`). The gear button shows only when `GET /sugerido/settings` answers 200.
- **Open question:** the backend has no "who am I" endpoint, so the frontend infers roles: settings 200 means admin; a 403 `FORBIDDEN_ROLE` on a write (POST run or PUT overrides) flips the panel to read-only for the rest of the session. Consequence: a viewer still sees the Calcular button until the first rejected write. A `GET /me` (role + sedes) would remove the guesswork.
- **Remaining:** F2b (Accesos screen), unit 6 (backtest), `sdd-verify`, `sdd-archive`.
