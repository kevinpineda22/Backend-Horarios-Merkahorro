-- Rollback of 004_shifts.sql. Destroys every saved schedule, shift and history row.
drop function if exists shifts_publish_week(text, date, int, uuid);
drop function if exists shifts_save_week(text, date, int, text[], jsonb, uuid);
drop table if exists shift_history;
drop table if exists shifts;
drop table if exists sede_week_schedules;
drop index if exists sugerido_sedes_siesa_code_key;
alter table sugerido_sedes drop column if exists siesa_code;
