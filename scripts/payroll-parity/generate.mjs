/**
 * Golden parity generator for the payroll engine.
 *
 * Runs the OLD scheduler's labor-engine.js and reports.js (READ-ONLY, inside a vm context) over a fixed
 * set of cases and writes test/horarios/fixtures/payrollParity.json. The committed test
 * (test/horarios/payrollParity.test.js) only reads that JSON; it never touches the old folder.
 *
 * Run it manually, in the Bogota timezone (the old code builds timestamps from LOCAL midnight):
 *   Git Bash:    TZ=America/Bogota node scripts/payroll-parity/generate.mjs
 *   PowerShell:  $env:TZ='America/Bogota'; node scripts/payroll-parity/generate.mjs
 * Optional: OLD_APP_DIR overrides the location of the old app (default below).
 *
 * Accepted deviation A8: the old app's festivos table has no 2027 rows beyond 2027-01-01, so from
 * 2027-01-11 it silently stops paying the holiday surcharge; this engine takes holidays from
 * calendar.js instead. Every case here therefore uses real 2026 dates with explicit holidays.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const OLD_APP_DIR = process.env.OLD_APP_DIR || "C:\\Users\\juan.isaza\\Desktop\\Horarios jorge\\horarios_jorge";
const OUT = fileURLToPath(new URL("../../test/horarios/fixtures/payrollParity.json", import.meta.url));

// ---------------------------------------------------------------- guards

if (new Date("2026-01-05T00:00:00").getTimezoneOffset() !== 300) {
  console.error(
    "ABORT: the old engine needs America/Bogota (UTC-5, no DST). Re-run with the TZ set, e.g.\n" +
      "  Git Bash:    TZ=America/Bogota node scripts/payroll-parity/generate.mjs\n" +
      "  PowerShell:  $env:TZ='America/Bogota'; node scripts/payroll-parity/generate.mjs",
  );
  process.exit(1);
}

// ---------------------------------------------------------------- old sources (read-only)

const FILES = ["assets/js/labor-engine.js", "assets/js/reports.js", "assets/js/common.js"];
const sources = {};
const sha = {};
for (const rel of FILES) {
  const text = readFileSync(path.join(OLD_APP_DIR, rel), "utf8").replace(/\r\n/g, "\n");
  sources[rel] = text;
  sha[rel] = createHash("sha256").update(text).digest("hex");
}
const [laborSrc, reportsSrc, commonSrc] = FILES.map((f) => sources[f]);

/** Index of the delimiter matching the opener at `open`, skipping strings, templates and comments. */
function matchClose(text, open) {
  const pairs = { "{": "}", "[": "]", "(": ")" };
  const stack = [pairs[text[open]]];
  let i = open + 1;
  while (i < text.length && stack.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i += 1;
      while (text[i] !== c) i += text[i] === "\\" ? 2 : 1;
    } else if (c === "`") {
      i += 1;
      while (text[i] !== "`") i += text[i] === "\\" ? 2 : 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (text[i] !== "\n") i += 1;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else if (pairs[c]) {
      stack.push(pairs[c]);
    } else if (c === stack[stack.length - 1]) {
      stack.pop();
    }
    i += 1;
  }
  if (stack.length) throw new Error("Unbalanced source while extracting");
  return i - 1;
}

/** Source of `function name(...) {...}` from `text`. */
function extractFunction(text, name) {
  const m = new RegExp(`^function ${name}\\(`, "m").exec(text);
  if (!m) throw new Error(`function ${name} not found in the old source`);
  const open = text.indexOf("{", text.indexOf(")", m.index));
  return text.slice(m.index, matchClose(text, open) + 1);
}

/** Source of `const name = [...];` from `text`. */
function extractConst(text, name) {
  const m = new RegExp(`^const ${name} = `, "m").exec(text);
  if (!m) throw new Error(`const ${name} not found in the old source`);
  const open = text.indexOf("[", m.index);
  return text.slice(m.index, matchClose(text, open) + 1) + ";";
}

/** Source of an object-literal method `name(...) {...}` (App.dateAdd / App.monday in common.js). */
function extractMethod(text, name) {
  const m = new RegExp(`^\\s+${name}\\(`, "m").exec(text);
  if (!m) throw new Error(`method ${name} not found in the old source`);
  const open = text.indexOf("{", text.indexOf(")", m.index));
  return text.slice(m.index, matchClose(text, open) + 1);
}

const FUNCTIONS = [
  "roundHours", "rangeValid", "dateUtc", "daysBetween", "cutWeekCount", "weekStartsBetween",
  "calculateEmployeeRow", "normalizeSiesaIdentifier", "siesaRows", "analyticsVariation",
];
const CONSTS = ["SIESA_HEADERS", "SIESA_CONCEPTS"];

// ---------------------------------------------------------------- vm context

const context = vm.createContext({});
vm.runInContext(
  `var App = { ${extractMethod(commonSrc, "dateAdd")}, ${extractMethod(commonSrc, "monday")} };`,
  context,
);
vm.runInContext("var window = {};", context);
vm.runInContext(laborSrc, context, { filename: "labor-engine.js" });
vm.runInContext("var LaborEngine = window.LaborEngine; var reportState = {};", context);

const reportsCode = [...CONSTS.map((c) => extractConst(reportsSrc, c)), ...FUNCTIONS.map((f) => extractFunction(reportsSrc, f))].join("\n\n");
const old = vm.runInContext(
  `${reportsCode}\n({ ${[...FUNCTIONS, ...CONSTS].join(", ")} });`,
  context,
  { filename: "reports.js (extracted)" },
);

for (const name of FUNCTIONS) {
  if (typeof old[name] !== "function") throw new Error(`extracted ${name} is not a function`);
}
if (!Array.isArray(old.SIESA_HEADERS) || old.SIESA_HEADERS.length !== 20) {
  throw new Error(`SIESA_HEADERS must have 20 entries, got ${old.SIESA_HEADERS?.length}`);
}
if (!Array.isArray(old.SIESA_CONCEPTS) || old.SIESA_CONCEPTS.map((c) => c.code).join() !== "103,105,108,113") {
  throw new Error("SIESA_CONCEPTS changed in the old code");
}

// ---------------------------------------------------------------- cases (new row shape)

const addDays = (fecha, n) => new Date(Date.parse(`${fecha}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const work = (cedula, fecha, startTime, endTime, breakMinutes = 0, sedeId = "003") => ({
  cedula, sedeId, fecha, tipo: "TRABAJO", startTime, endTime, breakMinutes,
});
const rest = (cedula, fecha, tipo = "DESCANSO") => ({ cedula, sedeId: "003", fecha, tipo, startTime: null, endTime: null, breakMinutes: 0 });

const C1 = "1012345678";
const C2 = "1098765432";
const C3 = "52111222";
const emp = (cedula = C1, siesaCode = "3") => ({ cedula, siesaCode });
const days = (monday, n = 7) => Array.from({ length: n }, (_, i) => addDays(monday, i));
const weekdays8h = (cedula, monday, count = 5, start = "08:00", end = "16:00", brk = 0) =>
  days(monday, count).map((d) => work(cedula, d, start, end, brk));

const W1 = "2026-08-31"; // first payroll cut of the new system
const HOLIDAYS_2026 = [
  "2026-01-01", "2026-01-12", "2026-03-23", "2026-04-02", "2026-04-03", "2026-05-01", "2026-05-18",
  "2026-06-08", "2026-06-15", "2026-06-29", "2026-07-20", "2026-08-07", "2026-08-17", "2026-10-12",
  "2026-11-02", "2026-11-16", "2026-12-08", "2026-12-25",
];

const cases = [];
const add = (name, from, to, employees, shifts, holidays = []) => cases.push({ name, from, to, holidays, employees, shifts });

add("2520 exact minutes", W1, addDays(W1, 6), [emp()],
  [...weekdays8h(C1, W1), work(C1, "2026-09-05", "08:00", "10:00")]);
add("2521st minute is extra", W1, addDays(W1, 6), [emp()],
  [...weekdays8h(C1, W1), work(C1, "2026-09-05", "08:00", "10:01")]);
add("48 h day-only week", W1, addDays(W1, 6), [emp()],
  [...weekdays8h(C1, W1), work(C1, "2026-09-05", "08:00", "16:00")]);
add("22:00-06:00 with a centered 60 min break", W1, addDays(W1, 6), [emp()],
  days(W1, 5).map((d) => work(C1, d, "22:00", "06:00", 60)));
add("Sunday-night crossing inside a 14 day cut", W1, addDays(W1, 13), [emp()],
  [work(C1, "2026-09-06", "22:00", "06:00"), work(C1, "2026-09-13", "22:00", "06:00")]);
add("previous-day spill", W1, addDays(W1, 6), [emp()],
  [work(C1, "2026-08-30", "20:00", "04:00"), work(C1, W1, "08:00", "16:00")]);
add("Monday holiday with night extras", "2026-08-17", "2026-08-23", [emp()],
  [work(C1, "2026-08-17", "22:00", "06:00"), ...weekdays8h(C1, "2026-08-18", 4), work(C1, "2026-08-22", "14:00", "23:00")],
  ["2026-08-17"]);
add("Sunday that is also a holiday (synthetic holiday)", W1, addDays(W1, 6), [emp()],
  [work(C1, "2026-09-06", "08:00", "16:00"), work(C1, "2026-09-06", "20:00", "23:00")], ["2026-09-06"]);
add("overlapping shifts in two sedes", W1, addDays(W1, 6), [emp()],
  [work(C1, W1, "08:00", "14:00", 0, "003"), work(C1, W1, "10:00", "18:00", 0, "011"), work(C1, "2026-09-01", "08:00", "12:00", 0, "003"), work(C1, "2026-09-01", "08:00", "12:00", 0, "011")]);
add("2521st minute at night", W1, addDays(W1, 6), [emp()],
  [...weekdays8h(C1, W1), work(C1, "2026-09-05", "17:00", "19:01")]);
add("rounding drift across two weeks", W1, addDays(W1, 13), [emp()],
  [
    work(C1, "2026-08-31", "00:00", "00:29"), work(C1, "2026-09-01", "00:00", "00:31"), work(C1, "2026-09-02", "00:00", "00:01"),
    work(C1, "2026-09-06", "08:00", "08:29"), work(C1, "2026-09-07", "00:00", "00:29"), work(C1, "2026-09-08", "00:00", "00:31"),
    work(C1, "2026-09-13", "08:00", "08:31"), work(C1, "2026-09-13", "10:00", "10:01"),
  ]);
add("end at 24:00", W1, addDays(W1, 6), [emp()], [work(C1, W1, "20:00", "24:00"), work(C1, "2026-09-06", "12:00", "24:00")]);
add("odd span with a 45 min break", W1, addDays(W1, 6), [emp()], [work(C1, W1, "08:00", "17:07", 45), work(C1, "2026-09-03", "21:13", "05:50", 45)]);
add("only DESCANSO and COMPENSATORIO", W1, addDays(W1, 6), [emp()],
  [rest(C1, W1), rest(C1, "2026-09-01", "COMPENSATORIO"), rest(C1, "2026-09-06")]);
add("Saturday to Sunday crossing", W1, addDays(W1, 6), [emp()], [work(C1, "2026-09-05", "22:00", "06:00")]);
add("break straddling 19:00", W1, addDays(W1, 6), [emp()], [work(C1, W1, "15:00", "23:00", 60)]);
add("Sunday night spilling into holiday Monday", "2026-08-10", "2026-08-23", [emp()],
  [work(C1, "2026-08-16", "22:00", "06:00"), work(C1, "2026-08-17", "20:00", "23:30")], ["2026-08-17"]);
add("2520th minute next to a break", W1, addDays(W1, 6), [emp()],
  [...[W1, "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"].map((d) => work(C1, d, "08:00", "17:00", 60)), work(C1, "2026-09-05", "08:00", "12:01", 1)]);
add("2 week cut with a holiday in week 2", "2026-10-05", "2026-10-18", [emp()],
  [...weekdays8h(C1, "2026-10-05", 4), ...weekdays8h(C1, "2026-10-12", 6), work(C1, "2026-10-11", "22:00", "06:00")], ["2026-10-12"]);
add("start equals end (24 h shift)", W1, addDays(W1, 6), [emp()], [work(C1, W1, "08:00", "08:00"), work(C1, "2026-09-03", "00:00", "00:00")]);
add("employee with several concepts across two weeks", "2026-08-10", "2026-08-23", [emp(C1, "3"), emp(C2, "011"), emp(C3, "7")],
  [
    ...weekdays8h(C1, "2026-08-10", 6), work(C1, "2026-08-16", "08:00", "16:00"), work(C1, "2026-08-17", "06:00", "14:00"),
    ...weekdays8h(C1, "2026-08-18", 4, "18:00", "03:00", 60), work(C1, "2026-08-23", "22:00", "06:00"),
    work(C2, "2026-08-16", "08:00", "13:00"), work(C2, "2026-08-23", "08:00", "13:00"), rest(C2, "2026-08-17"),
    rest(C3, "2026-08-10"),
  ],
  ["2026-08-17"]);
add("sede code padding and a non-numeric cedula", W1, addDays(W1, 6),
  [{ cedula: "CE123456", siesaCode: "5" }, { cedula: "1234567890123456", siesaCode: "0123" }],
  [work("CE123456", "2026-09-06", "08:00", "12:00"), work("1234567890123456", "2026-09-06", "08:00", "12:00")]);

// mulberry32: tiny seeded PRNG so the 60 random weeks are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260831);
const pick = (n) => Math.floor(rnd() * n);
const hhmm = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const MONDAYS_2026 = Array.from({ length: 52 }, (_, i) => addDays("2026-01-05", i * 7));
for (let n = 1; n <= 60; n += 1) {
  const from = MONDAYS_2026[pick(MONDAYS_2026.length)];
  const weeks = rnd() < 0.3 ? 2 : 1;
  const to = addDays(from, weeks * 7 - 1);
  const shifts = [];
  const count = 3 + pick(8) + (weeks - 1) * 3;
  for (let i = 0; i < count; i += 1) {
    const fecha = addDays(from, pick(weeks * 7 + 1) - (rnd() < 0.15 ? 1 : 0));
    const kind = rnd();
    if (kind < 0.1) {
      shifts.push(rest(C1, fecha, rnd() < 0.5 ? "DESCANSO" : "COMPENSATORIO"));
      continue;
    }
    const start = pick(96) * 15;
    const length = 60 + pick(14 * 4) * 15;
    const end = start + length;
    shifts.push(work(C1, fecha, hhmm(start), end === 1440 ? "24:00" : hhmm(end), rnd() < 0.5 ? 0 : [30, 45, 60][pick(3)], rnd() < 0.2 ? "011" : "003"));
  }
  const holidays = HOLIDAYS_2026.filter((h) => h >= addDays(from, -1) && h <= addDays(to, 7));
  add(`random week ${String(n).padStart(2, "0")} (seed 20260831)`, from, to, [emp()], shifts, holidays);
}

// ---------------------------------------------------------------- run the OLD code

function runOld(c) {
  const ids = new Map(c.employees.map((e, i) => [e.cedula, i + 1]));
  const stubs = c.employees.map((e) => ({ id: ids.get(e.cedula), cedula: e.cedula, almacen_codigo: e.siesaCode }));
  const shifts = c.shifts.map((s, i) => {
    if (!ids.has(s.cedula)) throw new Error(`case "${c.name}": shift for an unknown employee ${s.cedula}`);
    const base = { id: i + 1, id_empleado: ids.get(s.cedula), fecha: s.fecha };
    if (s.tipo === "TRABAJO") {
      return { ...base, categoria: "TRABAJO", es_compensatorio: 0, hora_inicio: s.startTime, hora_fin: s.endTime, minutos_descanso: s.breakMinutes };
    }
    return { ...base, categoria: "DESCANSO", es_compensatorio: s.tipo === "COMPENSATORIO" ? 1 : 0 };
  });
  context.reportState = {
    startDate: c.from,
    endDate: c.to,
    holidays: c.holidays.map((fecha) => ({ fecha })),
    rules: [],
  };
  const rows = stubs.map((stub) => old.calculateEmployeeRow(stub, shifts.filter((s) => s.id_empleado === stub.id)));
  const siesa = old.siesaRows(rows);
  return {
    rows: rows.map((r) => ({
      cedula: r.cedula,
      weeks: r.semanas.map((w) => ({
        weekStart: w.semana_inicio,
        workedHours: w.horas_trabajadas,
        extras: w.horas_extras,
        nocturnas: w.horas_nocturnas,
        dominicales: w.horas_dominicales,
        festivos: w.horas_festivas,
      })),
      totals: { extras: r.horas_extras, nocturnas: r.horas_nocturnas, dominicales: r.horas_dominicales, festivos: r.horas_festivas },
    })),
    siesa,
  };
}

const outCases = cases.map((c) => ({ ...c, expected: runOld(c) }));

const VARIATION_PAIRS = [
  [14, 10], [20, 16], [13.9, 10], [44, 40], [4, 0], [3.99, 0], [0, 0], [0, 6], [6, 10], [10, 10],
  [8.5, null], [12.34, 10.07], [3.9999999, 0], [26, 20.5], [21.5, 16.5], [5, 20],
];
const variations = VARIATION_PAIRS.map(([current, previous]) => ({
  current, previous, expected: JSON.parse(JSON.stringify(old.analyticsVariation(current, previous))),
}));

const fixture = {
  _comment: "Generated by scripts/payroll-parity/generate.mjs from the old scheduler. Do not edit by hand.",
  source: { files: FILES, sha256: sha, timezone: "America/Bogota" },
  headers: old.SIESA_HEADERS,
  cases: outCases,
  variations,
};

mkdirSync(path.dirname(OUT), { recursive: true });
const json = `${JSON.stringify(fixture, null, 1)}\n`;
writeFileSync(OUT, json);
console.log(`wrote ${OUT}`);
console.log(`cases: ${outCases.length}, variations: ${variations.length}`);
console.log(`fixture sha256: ${createHash("sha256").update(json).digest("hex")}`);
