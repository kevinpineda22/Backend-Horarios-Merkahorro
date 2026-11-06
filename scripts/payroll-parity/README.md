# Payroll parity

`generate.mjs` runs the OLD scheduler's `labor-engine.js` / `reports.js` (read-only) over fixed cases and writes
`test/horarios/fixtures/payrollParity.json`. The committed tests only read that JSON.

```
# Git Bash
TZ=America/Bogota node scripts/payroll-parity/generate.mjs
# PowerShell
$env:TZ='America/Bogota'; node scripts/payroll-parity/generate.mjs
```

The script aborts unless the process timezone is America/Bogota (the old code builds timestamps from local
midnight). `OLD_APP_DIR` overrides the old app folder.

## Holidays and accepted deviation A8

Holidays are injected into the engine as a `Set`; the service builds it from `calendar.js` (`getHoliday`).
`test/horarios/fixtures/festivos2026.json` is the old scheduler's 2026 table (18 dates) and
`payrollHolidays.test.js` asserts `getHoliday` returns exactly those dates.

The old table is loaded by hand and has no rows for 2024/2025 and only `2027-01-01` for 2027, so from
2027-01-11 the old app silently stops paying the holiday surcharge. The new system uses `calendar.js` and keeps
paying it. Payroll must sign off this difference (A8). Parity cases therefore use real 2026 dates with explicit
holidays.
