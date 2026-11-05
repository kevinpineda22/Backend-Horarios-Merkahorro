-- Seed: the 7 supermarkets covered by the cashier suggestion (business decision 2026-10-29).
-- Butcher shops (Carnes Barbosa, Carnes MK Lopez) and non-store locations are intentionally excluded:
-- their employees show up as unmappedSede and are visible only to admins.
--
-- bodegas: codes in merkahorro_siesa.ventas_pdv_resumen_cajeras.bodega (verified 2026-10-29).
--   Villahermosa also keeps PV002, its code before 2024-01-13, so its sales history is complete.
-- siesa_code: SIESA sede code (column added by 004_shifts.sql), snapshotted on every saved shift.
-- trazabilidad_aliases: sede text as it arrives from backend-trazabilidad / SIESA.
--   The trigger from 003_accesos.sql normalizes them into sugerido_sede_aliases.
--
-- Idempotent: safe to run more than once. Run AFTER 001..004.

insert into sugerido_sedes (sede_id, nombre, bodegas, trazabilidad_aliases, siesa_code, activo) values
  ('copacabana',       'Principal Copacabana', array['PV001'],          array['PRINCIPAL COPACABANA'], '001', true),
  ('girardota-parque', 'Girardota Parque',     array['00301'],          array['SEDE GIRARDOTA PARQUE'], '003', true),
  ('villahermosa',     'Villahermosa',         array['00201', 'PV002'], array['SEDE VILLAHERMOSA'], '002', true),
  ('barbosa',          'Barbosa',              array['00701'],          array['SEDE MERKAHORRO BARBOSA'], '006', true),
  ('girardota-llano',  'Girardota Llano',      array['00401'],          array['SEDE GIRARDOTA LLANO'], '004', true),
  ('san-juan',         'San Juan',             array['00801'],          array['SEDE MERKAHORRO SAN JUAN'], '008', true),
  ('las-vegas',        'Las Vegas',            array['00601'],          array['SEDE COPACABANA LAS VEGAS'], '007', true)
on conflict (sede_id) do update set
  nombre               = excluded.nombre,
  bodegas              = excluded.bodegas,
  trazabilidad_aliases = excluded.trazabilidad_aliases,
  siesa_code           = excluded.siesa_code,
  activo               = excluded.activo;

-- Check: 7 sedes and 7 normalized aliases.
select sede_id, nombre, siesa_code, bodegas, trazabilidad_aliases from sugerido_sedes order by sede_id;
select alias, sede_id from sugerido_sede_aliases order by sede_id;
