-- Rollback of 005_payroll_cuts.sql. Destroys every saved payroll cut, line, week and history row.
drop function if exists payroll_cut_void(bigint, text, uuid);
drop function if exists payroll_cut_save(date, date, jsonb, uuid);
drop table if exists payroll_cut_history;
drop table if exists payroll_cut_weeks;
drop table if exists payroll_cut_lines;
drop table if exists payroll_cuts;
