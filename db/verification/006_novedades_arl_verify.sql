-- 006_novedades_arl_verify.sql: manual verification of the novedades subtype / ARL migration.
-- Run in the Supabase SQL editor AFTER 006_novedades_arl.sql. NEVER run it as part of tests.
-- It runs everything inside ONE transaction and ends with ROLLBACK, so nothing is kept. Expected failures are
-- caught in nested BEGIN/EXCEPTION blocks (each one is a savepoint), so a raise that is part of a check does not
-- abort the rest. A failed check raises and stops the script; a final "ALL CHECKS PASSED" notice means every
-- check held.
--
-- Note: the SQL editor may run the whole script in one batch. If your editor auto-commits each statement,
-- run it from a psql session instead (begin/rollback are explicit below).

begin;

-- Inserts one far-future novedad (dies with the transaction). Everything else is a default.
create function pg_temp.nov(
  p_tipo text, p_subtipo text default null, p_adjunto text default null, p_firma text default null,
  p_resp uuid default null, p_sede_nombre text default null)
returns uuid language sql as $$
  insert into novedades (cedula, tipo, subtipo, fecha_inicio, fecha_fin, sede_nombre, adjunto_path, firma_path,
                         responsable_id, created_by)
  values ('99999999', p_tipo, p_subtipo, date '2031-01-06', date '2031-01-07', p_sede_nombre, p_adjunto, p_firma,
          p_resp, '00000000-0000-4000-8000-000000000001')
  returning id;
$$;

do $$
declare
  v_resp uuid := '00000000-0000-4000-8000-0000000000aa';
  v_adj text := '2031/01/3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab-adjunto.pdf';
  v_fir text := '2031/01/3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab-firma.png';
  v_id uuid;
  v_b storage.buckets;
  v_default text;
  v_arr text[];
begin
  -- 1. Structure: columns, RLS, no privileges for anon/authenticated.
  assert (select count(*) from information_schema.columns
           where table_name = 'novedades' and column_name in
             ('subtipo','sede_nombre','responsable_id','responsable_nombre','adjunto_path','firma_path')
             and is_nullable = 'YES') = 6, 'six new nullable columns';
  assert (select relrowsecurity from pg_class where oid = 'novedades'::regclass), 'RLS stays enabled on novedades';
  assert not has_table_privilege('anon', 'novedades', 'select') and not has_table_privilege('authenticated', 'novedades', 'select'),
    'anon/authenticated have no privileges on novedades';

  -- 2. Bucket: exists, private, 10 MB, only pdf/png/jpeg/webp.
  select * into v_b from storage.buckets where id = 'novedades-soportes';
  assert found, 'bucket novedades-soportes exists';
  assert v_b.public = false, 'bucket is private';
  assert v_b.file_size_limit = 10485760, 'bucket limit is 10 MB';
  assert v_b.allowed_mime_types @> array['application/pdf','image/png','image/jpeg','image/webp']
     and cardinality(v_b.allowed_mime_types) = 4, 'bucket mime types';

  -- 3. Rename: no Estudio left anywhere, scheduler still blocks the renamed type.
  assert not exists (select 1 from novedades where tipo = 'Estudio'), 'no Estudio rows';
  assert not exists (select 1 from sugerido_settings where 'Estudio' = any (blocking_absence_types)), 'no Estudio in blocking types';
  assert not exists (select 1 from sugerido_settings
                      where 'Vacaciones' = any (blocking_absence_types) and not 'Permisos académicos' = any (blocking_absence_types)),
    'blocking types that had Estudio now have Permisos académicos';

  -- 3b. Scheduler default: renamed label, original order, nothing left of Estudio.
  select column_default into v_default from information_schema.columns
   where table_name = 'sugerido_settings' and column_name = 'blocking_absence_types';
  assert v_default like '''{Incapacidades,Licencias,Vacaciones,Permisos,"Permisos académicos","Día de la Familia"}''%',
    'blocking_absence_types default is the renamed list in order';
  assert v_default not like '%Estudio%', 'default no longer mentions Estudio';

  -- 3c. Migrated arrays: no duplicates anywhere, and the migration expression (copied from 006, run on a literal
  -- so no settings row is needed) renames in place, keeps first-occurrence order and drops the duplicate.
  assert not exists (select 1 from sugerido_settings
                      where cardinality(blocking_absence_types) <> (select count(distinct x) from unnest(blocking_absence_types) x)),
    'no duplicated blocking types after the rename';
  select coalesce(array_agg(t order by first_pos), '{}') into v_arr
    from (
      select case when x = 'Estudio' then 'Permisos académicos' else x end as t, min(pos) as first_pos
        from unnest(array['Vacaciones', 'Estudio', 'Permisos', 'Permisos académicos', 'Estudio']) with ordinality as u(x, pos)
       group by 1
    ) s;
  assert v_arr = array['Vacaciones', 'Permisos académicos', 'Permisos'], 'rename keeps order and has no duplicates';

  -- 4. tipo CHECK: new label and the historical one are valid, the old one is not.
  perform pg_temp.nov('Permisos académicos');
  perform pg_temp.nov('Día de la Familia');
  begin
    perform pg_temp.nov('Estudio');
    raise exception 'expected check_violation for Estudio';
  exception when check_violation then null;
  end;

  -- 5. Subtipos consistent with the tipo.
  perform pg_temp.nov('Incapacidades', 'Enfermedad general');
  perform pg_temp.nov('Licencias', 'Remunerada');
  perform pg_temp.nov('Licencias', 'No remunerada');
  begin
    perform pg_temp.nov('Incapacidades', 'Remunerada');
    raise exception 'expected check_violation for Incapacidades/Remunerada';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.nov('Licencias', 'ARL');
    raise exception 'expected check_violation for Licencias/ARL';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.nov('Vacaciones', 'ARL');
    raise exception 'expected check_violation for Vacaciones with a subtipo';
  exception when check_violation then null;
  end;

  -- 6. ARL needs both files and the responsible.
  v_id := pg_temp.nov('Incapacidades', 'ARL', v_adj, v_fir, v_resp);
  assert v_id is not null, 'complete ARL novedad is accepted';
  begin
    perform pg_temp.nov('Incapacidades', 'ARL', null, v_fir, v_resp);
    raise exception 'expected check_violation for ARL without adjunto';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.nov('Incapacidades', 'ARL', v_adj, null, v_resp);
    raise exception 'expected check_violation for ARL without firma';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.nov('Incapacidades', 'ARL', v_adj, v_fir, null);
    raise exception 'expected check_violation for ARL without responsable';
  exception when check_violation then null;
  end;

  -- 6b. One file belongs to at most one novedad: partial unique indexes exist and reject reuse.
  assert (select count(*) from pg_indexes
           where tablename = 'novedades' and indexname in ('novedades_adjunto_path_key', 'novedades_firma_path_key')
             and indexdef ilike 'create unique index%' and indexdef ilike '%where%is not null%') = 2,
    'both partial unique indexes on adjunto_path / firma_path exist';
  begin
    perform pg_temp.nov('Incapacidades', 'ARL', v_adj, '2031/01/aaaaaaaa-5d4a-4b6e-9a1c-0123456789ab-firma.png', v_resp);
    raise exception 'expected unique_violation for a reused adjunto_path';
  exception when unique_violation then null;
  end;
  begin
    perform pg_temp.nov('Incapacidades', 'ARL', '2031/01/aaaaaaaa-5d4a-4b6e-9a1c-0123456789ab-adjunto.pdf', v_fir, v_resp);
    raise exception 'expected unique_violation for a reused firma_path';
  exception when unique_violation then null;
  end;

  -- 7. Other subtipos / tipos must not carry files.
  begin
    perform pg_temp.nov('Incapacidades', 'Enfermedad general', v_adj, v_fir, v_resp);
    raise exception 'expected check_violation for Enfermedad general with files';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.nov('Vacaciones', null, v_adj);
    raise exception 'expected check_violation for Vacaciones with a file';
  exception when check_violation then null;
  end;

  -- 8. Path format.
  begin
    perform pg_temp.nov('Incapacidades', 'ARL', '../etc/passwd', v_fir, v_resp);
    raise exception 'expected check_violation for a malformed adjunto path';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.nov('Incapacidades', 'ARL', v_adj, replace(v_fir, '.png', '.pdf'), v_resp);
    raise exception 'expected check_violation for a non-png signature';
  exception when check_violation then null;
  end;

  -- 9. sede_nombre: real SIESA text for a non-store sede (sede_id null); empty or oversized text is rejected.
  perform pg_temp.nov('Permisos', null, null, null, null, 'CORPORATIVO GENERAL');
  begin
    perform pg_temp.nov('Permisos', null, null, null, null, repeat('x', 121));
    raise exception 'expected check_violation for a 121-char sede_nombre';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.nov('Permisos', null, null, null, null, '');
    raise exception 'expected check_violation for an empty sede_nombre';
  exception when check_violation then null;
  end;

  -- 10. Rows created before the migration (Incapacidades / Licencias without subtipo) stay valid and cancellable.
  v_id := pg_temp.nov('Incapacidades');
  update novedades set anulada = true, anulada_at = now(), anulada_por = v_resp, motivo_anulacion = 'legacy' where id = v_id;
  assert (select anulada from novedades where id = v_id), 'a legacy Incapacidades row without subtipo can be cancelled';

  raise notice 'ALL CHECKS PASSED';
end
$$;

rollback;
