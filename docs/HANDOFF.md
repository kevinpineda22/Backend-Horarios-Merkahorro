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

Pending (not yet applied): `004_shifts.sql` (shift persistence: schedules, shifts, history, `shifts_save_week` / `shifts_publish_week`, `sugerido_sedes.siesa_code`), then re-run the seed. Rollback: `db/migrations/rollback/004_shifts.down.sql`. Manual checks: `db/verification/004_shifts_verify.sql` (runs inside a transaction and rolls back). API: `/api/horarios/sedes/:sedeId/weeks/:weekStart/{shifts,publish,history}`.

### Novedades: subtypes, ARL and support files (migration 006, branch `feat/novedades-arl`, not applied, not pushed)

Apply `db/migrations/006_novedades_arl.sql` in the SQL editor, then run `db/verification/006_novedades_arl_verify.sql` (single transaction, ends with ROLLBACK). Rollback: `db/migrations/rollback/006_novedades_arl.down.sql` (destroys subtype/ARL data; the bucket and its files must be removed from the Storage dashboard).

| Topic | Rule |
|---|---|
| Types | `Incapacidades`, `Licencias`, `Vacaciones`, `Permisos`, `Permisos académicos` (was `Estudio`; rows, CHECK and `sugerido_settings.blocking_absence_types` are migrated, so the scheduler blocks the same absences). `Día de la Familia` stays valid in the DB for history: reads return it, create/patch reject it. |
| Subtipo | Incapacidades requires `ARL` or `Enfermedad general`; Licencias requires `Remunerada` or `No remunerada`; any other tipo must have none. The DB CHECK tolerates a null subtipo on Incapacidades/Licencias so pre-006 rows stay valid and cancellable; the API enforces it on every write that touches tipo/subtipo/files. |
| Real sede | `sede_nombre` (raw SIESA text, 1-120 chars) travels with `sedeId`. `sede_id` stays the FK to stores (null for non-store sedes); null `sede_id` remains admin-only. |
| ARL | Requires `adjuntoPath` + `firmaPath` (storage object paths) and a responsible leader. `responsable_id` / `responsable_nombre` come from the session (`req.user.id`, `profiles.nombre`, falling back to the session email), never from the body. Other subtipos must have no files or responsable. Leaving ARL on a patch clears them; entering ARL or replacing the signature makes the caller the responsable. |
| Files | Private bucket `novedades-soportes` (10 MB, pdf/png/jpeg/webp), no storage policies. Files never go through the API (Vercel ~4.5 MB body limit): the client uploads straight to the bucket with the signed URL. Paths are `yyyy/mm/<uuid>-adjunto.<pdf, png, jpg or webp>` or `yyyy/mm/<uuid>-firma.png`, generated by the server and re-validated (pattern + existence in the bucket) on create/patch. |

Endpoints (all under `/api/novedades`, same auth/role/sede rules as the rest of the module):

| Endpoint | Roles | Notes |
|---|---|---|
| `POST /uploads` `{kind: "adjunto" or "firma", fileName, contentType, size, sedeId}` | admin, planner (sede-scoped by `sedeId`, null = admin only) | 200 `{path, signedUploadUrl, token}`. `firma` must be `image/png`; size <= 10 MB. Upload with supabase-js `storage.from("novedades-soportes").uploadToSignedUrl(path, token, file)`. |
| `GET /:id/files/:kind` (`adjunto` or `firma`) | admin, planner, viewer (sede of the novedad) | 200 `{url}`, a signed download URL valid 300 s. 404 `NOVEDAD_FILE_NOT_FOUND` when the novedad has no such file. Cancelled novedades stay readable. |
| `POST /`, `PATCH /:id` | admin, planner | New body fields: `subtipo`, `sedeNombre`, `adjuntoPath`, `firmaPath`. Validation errors are 400 `VALIDATION_ERROR` with `details[{path, message}]` in Spanish. |

Read DTO additions: `subtipo`, `sedeNombre`, `responsableNombre`, `hasAdjunto`, `hasFirma` (storage paths are never exposed).

**Deploy gap (read before shipping):** the currently deployed frontend sends no `detalles`, no historia / soporte, and always sends tipo + subtipo. With this backend it gets 400 `VALIDATION_ERROR` on create AND edit of Incapacidades (both subtipos), Licencias, Permisos and Permisos académicos, and on Vacaciones too (`periodo` / `fechaRegreso` are now required). Only reads, listing and anular keep working. So 007 + backend + the new frontend must go out back to back; do not leave the old frontend live against the new backend.

**Edit caveat:** resending `tipo` / `subtipo` (even unchanged) counts as touching them and forces the full per-type rules on a legacy row (`detalles = {}`). The frontend must not resend tipo / subtipo for legacy rows unless the user changed them, or the edit fails with 400 until the user fills the details.

**Deploy order:** (1) apply 006 in Supabase, (2) deploy the backend, (3) deploy the frontend. The old backend breaks after 006 (it still writes `Estudio`), and the new backend breaks before 006 (missing columns), so do 1 and 2 back to back.

**Deploy note:** Apply 006 and deploy this backend back to back, off-hours, with no sugerido run in between. (Between the two steps the old code drops Estudio-origin absences from the scheduler and fails to create Estudio novedades; deploying code first breaks every create.) 006 also adds partial unique indexes so a file belongs to one novedad (reuse answers 409 `NOVEDAD_FILE_IN_USE`). The rollback now snapshots `novedades` into `novedades_backup_006` first and is idempotent.

### Novedades: per-type details (migration 007, branch `feat/novedades-details`, not applied, not pushed)

Apply `db/migrations/007_novedades_detalles.sql` in the SQL editor (AFTER 006), then run `db/verification/007_novedades_detalles_verify.sql` (single transaction, ends with ROLLBACK). Rollback: `db/migrations/rollback/007_novedades_detalles.down.sql` (snapshots into `novedades_backup_007` first, destroys `detalles`/historia/soporte data and clears the adjunto of non-ARL incapacidades; bucket objects must be removed from the Storage dashboard).

What 007 adds: `detalles jsonb not null default '{}'` (CHECK: JSON object), `historia_path`, `soporte_path` (path CHECKs, partial unique indexes), a relaxed `novedades_arl_chk` (any incapacidad may carry an adjunto; firma and responsable stay ARL-only) and `novedades_files_chk` (historia only on Incapacidades, soporte only on Permisos / Permisos académicos). No CHECK looks inside `detalles` and nothing can reject an existing row.

Per-type rules live in the API (zod, `domain/novedadDetalles.js` and `domain/novedadTypes.js`). Errors are 400 `VALIDATION_ERROR`, `details[{path, message}]` in Spanish, paths like `body.detalles.motivo`. Unknown keys in `detalles` are rejected (`Campo no permitido: <key>`). Optional keys accept `null` / `""` (dropped); text is trimmed; the normalized object is what gets stored.

| Tipo / subtipo | `detalles` | Files | Other |
|---|---|---|---|
| Incapacidades ARL | `{}` | `adjuntoPath`, `historiaPath`, `firmaPath` required | `observacion` required; leader signature + responsable as in 006 |
| Incapacidades Enfermedad general | `duracion` required: `"Mayor a 3 días"` or `"Menor o igual a 3 días"`; must agree with the dates (the old form derived it): more than 3 inclusive days (`fechaFin - fechaInicio + 1`) with "Menor o igual a 3 días" is a 400 on `body.detalles.duracion` (also checked leniently when dates and duracion are present) | `adjuntoPath` required; `historiaPath` required for "Mayor a 3 días", optional otherwise; no firma | `observacion` required |
| Licencias (Remunerada / No remunerada) | `dias` integer 1..366 and `motivo` (1..1000) required; optional `liderAprueba` (<= 120), `fechaAprobacion` (date) | none | |
| Permisos | `motivo` required (<= 1000); optional `porHoras` boolean; when `true`, `horas` = 1..62 items `{fecha, inicio, fin}` (HH:MM, fin > inicio, fecha within fechaInicio..fechaFin); `horas` without `porHoras: true` is rejected | optional `soportePath` | |
| Permisos académicos | `modo` required (`parcial` / `libre` / `redistribuir`); `dias` required, 1..62 unique items `{fecha, inicio, fin}` (hours are per day, like the old EstudioForm); `inicio` + `fin` (HH:MM, fin > inicio) are required on every item for `parcial` and rejected on every item for `libre` / `redistribuir`; `detalle` required (<= 1000); there are no top-level `inicio` / `fin` (rejected as unknown keys) | optional `soportePath` | `fechaInicio` / `fechaFin` must equal the first / last day of `dias` (errors on `body.fechaInicio` / `body.fechaFin`); days are stored sorted |
| Vacaciones | `periodo` required (4-digit year, a number is stored as text) and `fechaRegreso` required (date >= fechaFin), on create and on strict PATCH; legacy rows stay lenient (see below) | none | |
| Día de la Familia | `{}` | none | Still not creatable; legacy rows stay readable |

Legacy rows (created before 007) have `detalles = {}`: they stay readable and editable. On PATCH the whole rule set (merged state) runs only when the patch touches `tipo`, `subtipo` or `detalles`. Otherwise only what the patch touches is judged: a touched file must be allowed for the tipo, a required file or the incapacidad `observacion` cannot be emptied, and changing `fechaInicio` / `fechaFin` re-checks existing details leniently (required fields are not enforced, present values are). `detalles` in a PATCH replaces the whole object. Changing `tipo` (or the subtipo of an incapacidad) without sending `detalles` resets them to `{}`, so the new required fields must be sent; files the new state cannot hold are cleared automatically; leaving ARL clears firma and responsable but keeps adjunto and historia.

New upload / download kinds: `POST /uploads` and `GET /:id/files/:kind` accept `historia` and `soporte` besides `adjunto` and `firma` (pdf / png / jpeg / webp, <= 10 MB; paths `yyyy/mm/<uuid>-historia.<ext>` and `yyyy/mm/<uuid>-soporte.<ext>`, generated by the server and re-validated plus existence-checked on create / patch; reuse answers 409 `NOVEDAD_FILE_IN_USE`).

Read DTO additions: `detalles` (as stored), `hasHistoria`, `hasSoporte` (paths are never exposed). Body additions on `POST /` and `PATCH /:id`: `detalles`, `historiaPath`, `soportePath`.

**Deploy order:** (1) apply 007 in Supabase, (2) deploy the backend, (3) deploy the frontend. Do 1 and 2 back to back: the new backend reads and writes the new columns (it breaks before 007), while the old backend keeps working after 007 except that it cannot create the new shapes (the relaxed ARL check is a superset of the old one).

### Checkout registers cap (migration 008, branch `feat/sugerido-registers`, not applied, not pushed)

Each sede has a fixed number of physical checkout registers ("puestos de pago"). The recommendation never suggests more simultaneous cashiers than registers, and leaders cannot schedule more either.

**Migration step:** apply `db/migrations/008_sugerido_registers.sql` in the SQL editor, then run `db/verification/008_sugerido_registers_verify.sql` (single transaction, ends with ROLLBACK). Rollback: `db/migrations/rollback/008_sugerido_registers.down.sql` (snapshots the overrides into `sugerido_sedes_registers_backup_008` first; redeploy the previous backend before running it). It only adds `sugerido_sedes.registers_override int` (NULL, CHECK 1..50).

**Deploy order: apply 008 BEFORE deploying the backend.** The new backend selects `registers_override` on every `sugerido_sedes` read (sede list, week view, runs), so it fails without the column. The old backend keeps working after 008.

**Where the count comes from:** `effective = override ?? derived ?? null`.
- `derived` = distinct `caja` per bodega in `merkahorro_siesa.ventas_pdv_resumen_cajeras`, over the 60 days ending at that bodega's latest data date (`fecha > ref - 60 AND fecha <= ref`; for a run `ref` is bounded by the end of the target week). `SIN_CAJA`, blanks and NULL are ignored; a sede sums its bodegas. A total of 0 means unknown (`null`). `caja` is reliable since 2024-06-01. Expected today: copacabana 10, girardota-parque 11, villahermosa 10, barbosa 8, girardota-llano 4, san-juan 3, las-vegas 3.
- `null` effective = no cap and no check. Unknown never blocks.
- Read paths (sede list, week view, override validation) cache the derived count per bodega for 10 minutes in memory and degrade to unknown if the sales database fails. A run always queries it fresh and fails like any other sales error.

**Run behaviour (cap applied when the run is computed):** each slot's `suggested = min(suggested, effective)`, so `final` follows when there is no override. `required`, `shortfall` and `status` stay as computed (real demand stays visible; a register cap is not a staff shortage). The run `inputs.registers` stores `{ derived, override, effective }` and, when any slot's `required` exceeds the registers, `warnings` gets one plain string `"REGISTERS_CAP: N franjas requieren más cajeras que los X puestos de pago de la sede; el sugerido se limitó a X."` (warnings are strings, the frontend drops anything else). **Changing an override only affects NEW runs**: the stored run is not re-capped on read. The daily recompute or the leader's "recalcular" refreshes it. The week payload exposes both the snapshot (`inputs.registers`) and the current values (`registers`), so the UI can tell the run is stale when they differ.

**Overrides ("Tu cambio"):** `PUT /sugerido/sedes/:sedeId/weeks/:weekStart/overrides` answers `422 REGISTERS_EXCEEDED` when any `value` is greater than the current effective registers (removals with `null` are never checked). Message: `La sede tiene {n} puestos de pago: no puedes programar más cajeras a la vez.` Body: `{ ok:false, error, code:"REGISTERS_EXCEEDED", details:{ registers:n, exceeded:[{fecha,franja,value}] } }`. Nothing is written.

**API contract**
- `registers` object everywhere: `{ derived: int|null, override: int|null, effective: int|null }`.
- `GET /sugerido/sedes` items: `{ sedeId, nombre, bodegas, activo, registers }` (one grouped query for all bodegas).
- `GET /sugerido/sedes/:sedeId/weeks/:weekStart` and the `POST .../runs` response: new top-level `registers` (current values; also present when `run` is null) plus `inputs.registers` (snapshot of the run).
- `PUT /sugerido/sedes/:sedeId/registers` (admin only, like `/settings`): body `{ "override": 1..50 | null }` (null clears it). Returns `{ data: { derived, override, effective } }`. 400 `VALIDATION_ERROR` for anything else, 404 `SEDE_NOT_MAPPED` for an unknown or inactive sede, 403 for non-admins.

Side effect on tests: listing sedes now touches the sales pool (lazily, on the first request), so `test/sugerido/wiring.test.js` no longer asserts it does not.

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
5. Novedades ARL (006): apply `006_novedades_arl.sql` -> deploy Backend-Horarios -> deploy the frontend (see the Novedades section above).
6. Novedades details (007): apply `007_novedades_detalles.sql` (after 006) -> deploy Backend-Horarios back to back -> deploy the frontend.
7. Registers cap (008): apply `008_sugerido_registers.sql` -> run its verify script -> deploy Backend-Horarios (it breaks before 008) -> deploy the frontend. Recompute the weeks you want capped.

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

## STATUS UPDATE 4 (2026-10-29, unit 6 backtest done) - latest

- **Backtest (task 6.1) is code-complete and uncommitted** on `feat/backtest` (branched from `main` a9891f3): **486/486** tests. New: `domain/backtest.js` (`aggregateToHour`, `wape`, `summarize`, `backtestWeek`), `test/sugerido/backtest.test.js`, `scripts/backtest.js`, `npm run backtest -- --weeks N [--sede id]`. `HISTORY_LOOKBACK_DAYS` is now exported from the service so the script reuses it. Full report: `docs/backtest-2026-10-29.md`.
- **Method:** for each of the last 8 complete weeks (2026-08-31 .. 2026-10-19) the forecast uses ONLY history with `fecha < weekStart` (leak test included) through the same `forecastWeek` the service calls; `dataAsOf` = last day with data before the week. Read-only (`BEGIN READ ONLY`), one query per sede, 2-9 s each.
- **Result: PASS.** Overall WAPE at sede x hour **13.7%** (bias +1.0%, 329,878 docs, 5,518 cells) vs the 20% target (design reference 14.8%).
  - Sedes: copacabana 11.8, girardota-parque 11.8, villahermosa 13.4, girardota-llano 15.1, las-vegas 15.8, san-juan 16.4, barbosa 16.7. None above 25%.
  - Weekdays: Mon 14.8, Tue 13.8, Wed 14.5, Thu 12.4, Fri 14.1, **Sat 13.1**, Sun 13.1. None above 25%.
  - Day type: weekday 13.7, sunday 13.1, holiday 19.6 (67 cells, bias +10.5%, over-forecast).
  - Worst hours: 20:00 27.9% (bias +6.3%), 07:00 19.8%, 08:00 16.3%. Worst sede x weekday cells: barbosa Mon 22.2%, barbosa Wed 19.5%, girardota-llano Sun 19.3%.
- **Saturday as its own dayType: not justified.** Saturday WAPE 13.1% vs Mon-Fri 13.9%; bias +1.4%. Splitting would halve the reference pool (4 same-weekday references already) for no accuracy gain. Keep Saturday as "weekday".
- **Optional tweaks (not implemented, none needed to pass):** (1) the 20:00 hour is the weakest (closing-time cut-offs vary); look at it before changing the model. (2) Holidays over-forecast by about 10%; only 67 cells, low priority. (3) barbosa Monday 22%: check for a sede-specific Monday pattern.
- **Caveat:** the backtest assumes the run is made on the Monday of the target week with data through Sunday (Sunday treated as partial, like the service). A run made earlier in the previous week would see staler data; rerun with a larger gap if the planner computes ahead.
- **Remaining:** F2b (Accesos screen), `sdd-verify`, `sdd-archive`.

## DEPLOY ORDER (payroll cuts, migration 005)

1. Apply `db/migrations/005_payroll_cuts.sql` (additive: the previous backend is unaffected).
2. Run the 005 verify script (psql, or a single-transaction editor so the test cuts roll back).
3. Deploy the backend. It needs the 005 tables/functions: `GET /report` and `GET /cuts` answer 500 without them.
4. Deploy the frontend.

Rollback: redeploy the previous backend BEFORE running the down script.
