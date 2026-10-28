-- ONE-OFF data correction (NOT a migration; do not run automatically).
-- Context: the company cedula standard strips leading zeros (backend-trazabilidad
-- normalizarCedula). Novedades written before src/shared/cedula.js may keep them.
-- Run manually in the Supabase SQL editor, in order.

-- 1) Check: expected result is 0.
select count(*) from novedades where cedula ~ '^0';

-- 1b) Rows that would normalize to fewer than 5 digits: expected result is empty.
--     The UPDATE below runs as one statement, so any row listed here would violate the
--     CHECK '^[0-9]{5,15}$' and abort it. Fix or cancel these rows by hand first.
select id, cedula from novedades
 where cedula ~ '^0' and length(regexp_replace(cedula, '^0+', '')) between 1 and 4;

-- 2) Correction (only if the count in step 1 is greater than 0 and step 1b is empty).
-- An all-zero value keeps its digits, same as normalizarCedula.
update novedades
   set cedula = coalesce(nullif(regexp_replace(cedula, '^0+', ''), ''), cedula)
 where cedula ~ '^0';

-- 3) Re-check: expected result is 0. A row that normalizes to fewer than 5 digits would
--    violate the CHECK '^[0-9]{5,15}$' and make step 2 fail; fix those rows by hand.
select count(*) from novedades where cedula ~ '^0' and cedula !~ '^0+$';
