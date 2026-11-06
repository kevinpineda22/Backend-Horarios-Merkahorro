-- Rollback of 007_novedades_detalles.sql. Destroys `detalles`, historia_path and soporte_path of every novedad, and
-- clears the adjunto of every non-ARL incapacidad (the 006 check only allows an adjunto on ARL). Files already uploaded
-- to the novedades-soportes bucket are NOT deleted by SQL (Supabase blocks direct deletes on storage tables): remove
-- the *-historia.* and *-soporte.* objects from the Storage dashboard if they are no longer needed.
-- Only meaningful together with a backend deploy that predates 007 (it does not know the new columns).
-- Idempotent. FIRST it copies the whole table into novedades_backup_007 (kept if it already exists, so a re-run never
-- overwrites the first snapshot); drop that table by hand once the rollback is confirmed.

create table if not exists novedades_backup_007 as select * from novedades;
alter table novedades_backup_007 enable row level security; -- no policies: service role only

drop index if exists novedades_historia_path_key;
drop index if exists novedades_soporte_path_key;

alter table novedades drop constraint if exists novedades_detalles_chk;
alter table novedades drop constraint if exists novedades_files_chk;
alter table novedades drop constraint if exists novedades_extra_paths_chk;
alter table novedades drop constraint if exists novedades_arl_chk;

-- 006 only allows an adjunto on ARL rows: clear the ones 007 made legal before the old check comes back.
update novedades set adjunto_path = null where coalesce(subtipo, '') <> 'ARL';

alter table novedades add constraint novedades_arl_chk check (
  (coalesce(subtipo, '') = 'ARL' and adjunto_path is not null and firma_path is not null and responsable_id is not null)
  or (coalesce(subtipo, '') <> 'ARL' and adjunto_path is null and firma_path is null));

alter table novedades drop column if exists detalles;
alter table novedades drop column if exists historia_path;
alter table novedades drop column if exists soporte_path;
