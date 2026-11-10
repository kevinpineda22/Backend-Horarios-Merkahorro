-- Rollback of 010_unpublish_schedule.sql. Removes shifts_unpublish_week and every DESPUBLICAR history row (the 004
-- constraints cannot hold them). Redeploy the backend that predates 010 first.
-- Idempotent. The DESPUBLICAR rows are copied into shift_history_backup_010 first (kept if it already exists, so a
-- re-run never overwrites the first snapshot); drop that table by hand once the rollback is confirmed.
-- Weeks that were unpublished stay BORRADOR: re-publish them from the app if needed.

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'shift_history_backup_010') then
    execute 'create table shift_history_backup_010 as select * from shift_history where action = ''DESPUBLICAR''';
    execute 'alter table shift_history_backup_010 enable row level security'; -- no policies: service role only
    execute 'revoke all on table shift_history_backup_010 from anon, authenticated';
  end if;
end $$;

drop function if exists shifts_unpublish_week(text, date, int, uuid);

delete from shift_history where action = 'DESPUBLICAR';

alter table shift_history drop constraint if exists shift_history_action_chk;
alter table shift_history drop constraint if exists sh_shape_chk;

alter table shift_history add constraint shift_history_action_chk
  check (action in ('CREAR','EDITAR','ELIMINAR','EDITAR_PUBLICADO','PUBLICAR'));

alter table shift_history add constraint sh_shape_chk check (
    (action = 'PUBLICAR' and shift_id is null and cedula is null and fecha is null and before is null and after is not null)
 or (action = 'CREAR'    and shift_id is not null and before is null and after is not null)
 or (action = 'EDITAR'   and shift_id is not null and before is not null and after is not null)
 or (action = 'ELIMINAR' and shift_id is not null and before is not null and after is null)
 or (action = 'EDITAR_PUBLICADO' and shift_id is not null and (before is not null or after is not null)));
