-- 007_novedades_detalles_verify.sql: manual verification of the novedades detalles / historia / soporte migration.
-- Run in the Supabase SQL editor AFTER 007_novedades_detalles.sql. NEVER run it as part of tests.
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
  p_resp uuid default null, p_historia text default null, p_soporte text default null,
  p_detalles jsonb default null)
returns uuid language sql as $$
  insert into novedades (cedula, tipo, subtipo, fecha_inicio, fecha_fin, adjunto_path, firma_path, responsable_id,
                         historia_path, soporte_path, detalles, created_by)
  values ('99999999', p_tipo, p_subtipo, date '2031-01-06', date '2031-01-07', p_adjunto, p_firma, p_resp,
          p_historia, p_soporte, coalesce(p_detalles, '{}'::jsonb), '00000000-0000-4000-8000-000000000001')
  returning id;
$$;

do $$
declare
  v_resp uuid := '00000000-0000-4000-8000-0000000000aa';
  v_adj text := '2031/01/3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab-adjunto.pdf';
  v_fir text := '2031/01/3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab-firma.png';
  v_his text := '2031/01/3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab-historia.pdf';
  v_sop text := '2031/01/3f2b8c1e-5d4a-4b6e-9a1c-0123456789ab-soporte.jpg';
  v_id uuid;
begin
  -- 1. Structure: columns, default, RLS, no privileges for anon/authenticated.
  assert (select count(*) from information_schema.columns
           where table_name = 'novedades' and column_name in ('detalles', 'historia_path', 'soporte_path')) = 3,
    'three new columns';
  assert (select count(*) from information_schema.columns
           where table_name = 'novedades' and column_name in ('historia_path', 'soporte_path') and is_nullable = 'YES') = 2,
    'historia_path and soporte_path are nullable';
  assert (select is_nullable = 'NO' from information_schema.columns
           where table_name = 'novedades' and column_name = 'detalles'), 'detalles is not null';
  assert (select column_default like '''{}''%' from information_schema.columns
           where table_name = 'novedades' and column_name = 'detalles'), 'detalles defaults to {}';
  assert (select relrowsecurity from pg_class where oid = 'novedades'::regclass), 'RLS stays enabled on novedades';
  assert not has_table_privilege('anon', 'novedades', 'select') and not has_table_privilege('authenticated', 'novedades', 'select'),
    'anon/authenticated have no privileges on novedades';

  assert exists (select 1 from pg_constraint
                  where conrelid = 'novedades'::regclass and conname = 'novedades_detalles_chk'
                    and pg_get_constraintdef(oid) like '%jsonb_typeof%'), 'detalles is constrained by jsonb_typeof';

  -- 2. detalles: defaults to {}, accepts an object, rejects anything that is not an object.
  v_id := pg_temp.nov('Permisos');
  assert (select detalles = '{}'::jsonb from novedades where id = v_id), 'a row without detalles gets {}';
  perform pg_temp.nov('Licencias', 'Remunerada', p_detalles => '{"dias": 3, "motivo": "calamidad"}'::jsonb);
  begin
    perform pg_temp.nov('Permisos', p_detalles => '[]'::jsonb);
    raise exception 'expected check_violation for an array detalles';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.nov('Permisos', p_detalles => '"texto"'::jsonb);
    raise exception 'expected check_violation for a scalar detalles';
  exception when check_violation then null;
  end;
  begin
    insert into novedades (cedula, tipo, fecha_inicio, fecha_fin, detalles, created_by)
    values ('99999999', 'Permisos', date '2031-01-06', date '2031-01-07', null, '00000000-0000-4000-8000-000000000001');
    raise exception 'expected not_null_violation for a null detalles';
  exception when not_null_violation then null;
  end;

  -- 3. Relaxed ARL check: an Enfermedad general incapacidad may carry adjunto + historia, but never a firma.
  perform pg_temp.nov('Incapacidades', 'Enfermedad general', v_adj, null, null, v_his, null, '{"duracion": "Mayor a 3 días"}'::jsonb);
  begin
    perform pg_temp.nov('Incapacidades', 'Enfermedad general', v_adj, v_fir);
    raise exception 'expected check_violation for Enfermedad general with a firma';
  exception when check_violation then null;
  end;
  v_id := pg_temp.nov('Incapacidades', 'ARL', '2031/01/aaaaaaaa-5d4a-4b6e-9a1c-0123456789ab-adjunto.pdf',
                      '2031/01/aaaaaaaa-5d4a-4b6e-9a1c-0123456789ab-firma.png', v_resp,
                      '2031/01/aaaaaaaa-5d4a-4b6e-9a1c-0123456789ab-historia.pdf');
  assert v_id is not null, 'a complete ARL novedad with historia is accepted';
  begin
    perform pg_temp.nov('Incapacidades', 'ARL', null, '2031/01/bbbbbbbb-5d4a-4b6e-9a1c-0123456789ab-firma.png', v_resp);
    raise exception 'expected check_violation for ARL without adjunto';
  exception when check_violation then null;
  end;

  -- 4. Files stay tied to their tipo.
  begin
    perform pg_temp.nov('Vacaciones', null, '2031/01/cccccccc-5d4a-4b6e-9a1c-0123456789ab-adjunto.pdf');
    raise exception 'expected check_violation for Vacaciones with an adjunto';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.nov('Permisos', null, null, null, null, '2031/01/dddddddd-5d4a-4b6e-9a1c-0123456789ab-historia.pdf');
    raise exception 'expected check_violation for Permisos with a historia';
  exception when check_violation then null;
  end;
  perform pg_temp.nov('Permisos', null, null, null, null, null, v_sop);
  perform pg_temp.nov('Permisos académicos', null, null, null, null, null, '2031/01/eeeeeeee-5d4a-4b6e-9a1c-0123456789ab-soporte.pdf');
  begin
    perform pg_temp.nov('Vacaciones', null, null, null, null, null, '2031/01/ffffffff-5d4a-4b6e-9a1c-0123456789ab-soporte.pdf');
    raise exception 'expected check_violation for Vacaciones with a soporte';
  exception when check_violation then null;
  end;

  -- 5. Path format.
  begin
    perform pg_temp.nov('Incapacidades', 'Enfermedad general', v_adj, null, null, '../etc/passwd');
    raise exception 'expected check_violation for a malformed historia path';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.nov('Permisos', null, null, null, null, null, replace(v_sop, '.jpg', '.gif'));
    raise exception 'expected check_violation for a soporte with a disallowed extension';
  exception when check_violation then null;
  end;

  -- 6. One file belongs to at most one novedad: partial unique indexes exist and reject reuse.
  assert (select count(*) from pg_indexes
           where tablename = 'novedades' and indexname in ('novedades_historia_path_key', 'novedades_soporte_path_key')
             and indexdef ilike 'create unique index%' and indexdef ilike '%where%is not null%') = 2,
    'both partial unique indexes on historia_path / soporte_path exist';
  begin
    perform pg_temp.nov('Incapacidades', 'Enfermedad general', '2031/01/99999999-5d4a-4b6e-9a1c-0123456789ab-adjunto.pdf', null, null, v_his);
    raise exception 'expected unique_violation for a reused historia_path';
  exception when unique_violation then null;
  end;
  begin
    perform pg_temp.nov('Permisos', null, null, null, null, null, v_sop);
    raise exception 'expected unique_violation for a reused soporte_path';
  exception when unique_violation then null;
  end;

  -- 7. Legacy rows (as created by 006: no detalles, no historia, ARL with only adjunto + firma) stay valid and cancellable.
  v_id := pg_temp.nov('Incapacidades', 'ARL', '2031/01/12121212-5d4a-4b6e-9a1c-0123456789ab-adjunto.pdf',
                      '2031/01/12121212-5d4a-4b6e-9a1c-0123456789ab-firma.png', v_resp);
  assert (select detalles = '{}'::jsonb and historia_path is null from novedades where id = v_id), 'legacy ARL shape is valid';
  update novedades set anulada = true, anulada_at = now(), anulada_por = v_resp, motivo_anulacion = 'legacy' where id = v_id;
  assert (select anulada from novedades where id = v_id), 'a legacy ARL row can be cancelled';

  raise notice 'ALL CHECKS PASSED';
end
$$;

rollback;
