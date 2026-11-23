import { spanMinutes } from "./weekPayload.js";
import { ORDINARY_WEEK_MINUTES } from "./payrollRules.js";

/**
 * Cashier team overtime control (pure). The team may publish up to TEAM_OVERTIME_HOURS of overtime per sede-week
 * without approval; beyond that it needs approved overtime requests. Twin of frontend utils/overtime.js.
 *
 * Rows are camelCase: { cedula, tipo, startTime, endTime, breakMinutes }. Only THIS schedule's rows count
 * (no neighbor sedes): the budget belongs to the team schedule being published.
 */

export const TEAM_OVERTIME_HOURS = 10;
export const TEAM_WEEKLY_LIMIT_MINUTES = ORDINARY_WEEK_MINUTES; // 42 h: beyond it, a person works overtime

const workedMinutes = (row) => Math.max(0, spanMinutes(row.startTime, row.endTime) - (row.breakMinutes ?? 0));

/** Sum over people of max(0, worked - 42 h), in integer minutes. */
export function teamOvertimeMinutes(rows) {
  const byCedula = new Map();
  for (const row of rows) {
    if (row.tipo !== "TRABAJO") continue;
    byCedula.set(row.cedula, (byCedula.get(row.cedula) ?? 0) + workedMinutes(row));
  }
  let total = 0;
  for (const minutes of byCedula.values()) total += Math.max(0, minutes - TEAM_WEEKLY_LIMIT_MINUTES);
  return total;
}
