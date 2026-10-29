-- Seed: the 7 supermarkets covered by the cashier suggestion (business decision 2026-10-29).
-- Butcher shops (Carnes Barbosa, Carnes MK Lopez) and non-store locations are intentionally excluded:
-- their employees show up as unmappedSede and are visible only to admins.
--
-- bodegas: codes in merkahorro_siesa.ventas_pdv_resumen_cajeras.bodega (verified 2026-10-29).
--   Villahermosa also keeps PV002, its code before 2024-01-13, so its sales history is complete.
-- trazabilidad_aliases: sede text as it arrives from backend-trazabilidad / SIESA.
--   The trigger from 003_accesos.sql normalizes them into sugerido_sede_aliases.
--
-- Idempotent: safe to run more than once. Run AFTER 001, 002 and 003.

insert into sugerido_sedes (sede_id, nombre, bodegas, trazabilidad_aliases, activo) values
  ('copacabana',       'Principal Copacabana', array['PV001'],          array['PRINCIPAL COPACABANA'],      true),
  ('girardota-parque', 'Girardota Parque',     array['00301'],          array['SEDE GIRARDOTA PARQUE'],     true),
  ('villahermosa',     'Villahermosa',         array['00201', 'PV002'], array['SEDE VILLAHERMOSA'],         true),
  ('barbosa',          'Barbosa',              array['00701'],          array['SEDE MERKAHORRO BARBOSA'],   true),
  ('girardota-llano',  'Girardota Llano',      array['00401'],          array['SEDE GIRARDOTA LLANO'],      true),
  ('san-juan',         'San Juan',             array['00801'],          array['SEDE MERKAHORRO SAN JUAN'],  true),
  ('las-vegas',        'Las Vegas',            array['00601'],          array['SEDE COPACABANA LAS VEGAS'], true)
on conflict (sede_id) do update set
  nombre               = excluded.nombre,
  bodegas              = excluded.bodegas,
  trazabilidad_aliases = excluded.trazabilidad_aliases,
  activo               = excluded.activo;

-- Check: 7 sedes and 7 normalized aliases.
select sede_id, nombre, bodegas, trazabilidad_aliases from sugerido_sedes order by sede_id;
select alias, sede_id from sugerido_sede_aliases order by sede_id;
