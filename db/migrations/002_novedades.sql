-- 002_novedades.sql
-- Absence records (vacations, incapacidades, licencias, ...) owned by this backend.
-- Apply manually in the Supabase SQL editor AFTER 001_sugerido.sql.
-- Only the backend (service role) touches this table: RLS is enabled with no policies.

create table if not exists novedades (
  id uuid primary key default gen_random_uuid(),
  -- Normalized value: digits only (the API strips spaces and dots before insert).
  cedula text not null check (cedula ~ '^[0-9]{5,15}$'),
  -- Same strings as sugerido_settings.blocking_absence_types (NFC "Día de la Familia").
  tipo text not null check (tipo in ('Incapacidades', 'Licencias', 'Vacaciones', 'Permisos', 'Estudio', 'Día de la Familia')),
  fecha_inicio date not null,
  fecha_fin date not null,
  observacion text check (char_length(observacion) <= 1000),
  -- Null sede: visible and editable by admins only.
  sede_id text references sugerido_sedes (sede_id),
  anulada boolean not null default false,
  anulada_por uuid,
  anulada_at timestamptz,
  motivo_anulacion text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint novedades_rango_chk check (fecha_fin >= fecha_inicio),
  constraint novedades_anulacion_chk check (anulada = (anulada_at is not null))
);

create index if not exists novedades_cedula_rango_idx on novedades (cedula, fecha_inicio, fecha_fin);
create index if not exists novedades_sede_idx on novedades (sede_id);
create index if not exists novedades_rango_idx on novedades (fecha_inicio, fecha_fin) where not anulada;

alter table novedades enable row level security;
revoke all on table novedades from anon, authenticated;
