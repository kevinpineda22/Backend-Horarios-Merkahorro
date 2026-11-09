-- Rollback of 009_shifts_people_counts.sql. Redeploy the backend that predates the schedules list first.
drop function if exists shifts_people_counts(uuid[]);
