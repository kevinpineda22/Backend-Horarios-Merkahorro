-- Rollback of 006_novedades_arl.sql. Destroys subtipo, sede_nombre, responsable and file-path data of every
-- novedad. Files already uploaded to the novedades-soportes bucket are NOT deleted by SQL (Supabase blocks direct
-- deletes on storage tables): empty and delete the bucket from the Storage dashboard if it is no longer needed.
-- Only meaningful together with a backend deploy that predates 006 (it does not know "Permisos académicos").
-- Idempotent. FIRST it copies the whole table into novedades_backup_006 (kept if it already exists, so a re-run never
-- overwrites the first snapshot); drop that table by hand once the rollback is confirmed.

create table if not exists novedades_backup_006 as select * from novedades;
alter table novedades_backup_006 enable row level security; -- no policies: service role only

drop index if exists novedades_adjunto_path_key;
drop index if exists novedades_firma_path_key;

alter table novedades drop constraint if exists novedades_tipo_chk;
alter table novedades drop constraint if exists novedades_tipo_check;
alter table novedades drop constraint if exists novedades_subtipo_chk;
alter table novedades drop constraint if exists novedades_arl_chk;
alter table novedades drop constraint if exists novedades_paths_chk;
alter table novedades drop constraint if exists novedades_sede_nombre_chk;

update novedades set tipo = 'Estudio' where tipo = 'Permisos académicos';

alter table novedades add constraint novedades_tipo_check check (tipo in ('Incapacidades', 'Licencias', 'Vacaciones', 'Permisos', 'Estudio', 'Día de la Familia'));

alter table novedades drop column if exists subtipo;
alter table novedades drop column if exists sede_nombre;
alter table novedades drop column if exists responsable_id;
alter table novedades drop column if exists responsable_nombre;
alter table novedades drop column if exists adjunto_path;
alter table novedades drop column if exists firma_path;

update sugerido_settings
   set blocking_absence_types = array_replace(blocking_absence_types, 'Permisos académicos', 'Estudio')
 where 'Permisos académicos' = any (blocking_absence_types);

alter table sugerido_settings alter column blocking_absence_types set default '{Incapacidades,Licencias,Vacaciones,Permisos,Estudio,"Día de la Familia"}';
