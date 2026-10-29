// Read-only forecast backtest: for each of the last N complete weeks, forecast with ONLY the history
// before that week (same model as the service) and compare against the real hourly demand.
//   npm run backtest -- --weeks 8 [--sede copacabana]
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getPool } from "../src/shared/db/pg.js";
import { createSalesRepo } from "../src/modules/sugerido/repositories/sales.pg.js";
import { HISTORY_LOOKBACK_DAYS } from "../src/modules/sugerido/sugerido.service.js";
import { addDays, bogotaToday, mondayOf } from "../src/modules/sugerido/domain/dates.js";
import { backtestWeek, summarize } from "../src/modules/sugerido/domain/backtest.js";

// Sede -> bodegas, from db/seeds/sugerido_sedes.sql (no Supabase needed).
const SEDES = {
  copacabana: ["PV001"],
  "girardota-parque": ["00301"],
  villahermosa: ["00201", "PV002"],
  barbosa: ["00701"],
  "girardota-llano": ["00401"],
  "san-juan": ["00801"],
  "las-vegas": ["00601"],
};
const TARGET = 0.2;
const WARN = 0.25;
const DOW = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function parseArgs(argv) {
  const out = { weeks: 8, sede: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--weeks") out.weeks = Number(argv[++i]);
    else if (argv[i] === "--sede") out.sede = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(out.weeks) || out.weeks < 1 || out.weeks > 26) throw new Error("--weeks must be an integer 1..26");
  if (out.sede && !SEDES[out.sede]) throw new Error(`Unknown sede: ${out.sede}`);
  return out;
}

const pct = (v) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const signed = (v) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
const table = (head, lines) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...lines.map((l) => `| ${l.join(" | ")} |`)].join("\n");
const statLine = (label, g) => [label, pct(g.wape), signed(g.bias), String(g.actual), String(Math.round(g.forecast)), String(g.n)];
const STAT_HEAD = ["WAPE", "Bias", "Actual docs", "Forecast docs", "Hour cells"];

async function loadSede(salesRepo, bodegas, weekStarts) {
  const desde = addDays(weekStarts[weekStarts.length - 1], -HISTORY_LOOKBACK_DAYS);
  const hasta = addDays(weekStarts[0], 6);
  const history = await salesRepo.loadSlotHistory({ bodegas, desde, hasta });
  return history;
}

async function main() {
  const { weeks, sede } = parseArgs(process.argv.slice(2));
  const today = bogotaToday();
  const lastWeek = addDays(mondayOf(today), -7); // last complete week
  const weekStarts = Array.from({ length: weeks }, (_, i) => addDays(lastWeek, -7 * i)); // most recent first
  const salesRepo = createSalesRepo({ connect: () => getPool().connect() });
  const ids = sede ? [sede] : Object.keys(SEDES);

  const rows = [];
  const runtimes = {};
  const failures = [];
  for (const id of ids) {
    const t0 = Date.now();
    let history;
    try {
      history = await loadSede(salesRepo, SEDES[id], weekStarts);
    } catch (err) {
      console.error(`${id}: ${err.code ?? err.message} - retrying once`);
      try {
        history = await loadSede(salesRepo, SEDES[id], weekStarts);
      } catch (err2) {
        failures.push(`${id}: ${err2.code ?? ""} ${err2.message}`);
        runtimes[id] = Date.now() - t0;
        continue;
      }
    }
    for (const w of weekStarts) for (const r of backtestWeek({ history, weekStart: w })) rows.push({ sede: id, ...r });
    runtimes[id] = Date.now() - t0;
    console.error(`${id}: ${(runtimes[id] / 1000).toFixed(1)}s`);
  }
  if (rows.length === 0) {
    console.error(`No results. Failures:\n${failures.join("\n")}`);
    process.exitCode = 1;
    return;
  }

  const labeled = rows.map((r) => ({ ...r, weekdayName: DOW[r.weekday] }));
  const s = summarize(labeled, ["sede", "weekday", "dayType", "week", "hour"]);
  const minHourActual = s.overall.actual * 0.01;
  const worstHours = s.by.hour.filter((g) => g.actual >= minHourActual && g.wape !== null).sort((a, b) => b.wape - a.wape).slice(0, 5);
  const weekday = s.by.weekday.map((g) => statLine(DOW[g.group], g));
  const monFri = summarize(labeled.filter((r) => r.weekday <= 5), []).overall;

  const verdict = s.overall.wape <= TARGET ? "PASS" : "FAIL";
  const over = [
    ...s.by.sede.filter((g) => g.wape > WARN).map((g) => `sede ${g.group} ${pct(g.wape)}`),
    ...s.by.weekday.filter((g) => g.wape > WARN).map((g) => `weekday ${DOW[g.group]} ${pct(g.wape)}`),
  ];
  const params = `Weeks: ${weeks} (${weekStarts[weekStarts.length - 1]} .. ${weekStarts[0]}), sedes: ${ids.join(", ")}, lookback ${HISTORY_LOOKBACK_DAYS} d, run ${today} (Bogota)`;

  const parts = [
    `# Forecast backtest ${today}`,
    params,
    `Model: forecast-blend-v1 (forecastWeek), history strictly before each week. Unit: sede x hour, docs = facturas + devoluciones. Target WAPE <= ${TARGET * 100}%.`,
    `## Overall: ${verdict}\n${table(["Scope", ...STAT_HEAD], [statLine("All", s.overall)])}`,
    `Mon-Fri only: WAPE ${pct(monFri.wape)}, bias ${signed(monFri.bias)}. Saturday: ${pct(s.by.weekday.find((g) => g.group === 6)?.wape ?? null)}.`,
    `## Per sede\n${table(["Sede", ...STAT_HEAD], s.by.sede.map((g) => statLine(g.group, g)))}`,
    `## Per weekday (Saturday separate on purpose)\n${table(["Weekday", ...STAT_HEAD], weekday)}`,
    `## Per day type\n${table(["Day type", ...STAT_HEAD], s.by.dayType.map((g) => statLine(g.group, g)))}`,
    `## Per week (week start)\n${table(["Week", ...STAT_HEAD], s.by.week.map((g) => statLine(g.group, g)))}`,
    `## Worst 5 hours of day (hours with >= 1% of all demand)\n${table(["Hour", ...STAT_HEAD], worstHours.map((g) => statLine(`${String(g.group).padStart(2, "0")}:00`, g)))}`,
    `## Sede x weekday WAPE\n${table(["Sede", ...DOW.slice(1)], Object.keys(SEDES).filter((id) => ids.includes(id)).map((id) => {
      const per = summarize(labeled.filter((r) => r.sede === id), ["weekday"]).by.weekday;
      return [id, ...DOW.slice(1).map((_, i) => pct(per.find((g) => g.group === i + 1)?.wape ?? null))];
    }))}`,
    `## Runtime per sede\n${Object.entries(runtimes).map(([k, v]) => `- ${k}: ${(v / 1000).toFixed(1)}s`).join("\n")}`,
    over.length ? `## Above ${WARN * 100}%\n${over.map((o) => `- ${o}`).join("\n")}` : `## Above ${WARN * 100}%\nNone.`,
    failures.length ? `## Failures\n${failures.map((f) => `- ${f}`).join("\n")}` : "",
  ].filter(Boolean);
  const md = parts.join("\n\n") + "\n";

  console.log(md);
  writeFileSync(fileURLToPath(new URL(`../docs/backtest-${today}.md`, import.meta.url)), md);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => { console.error(err.message); process.exit(1); },
);
