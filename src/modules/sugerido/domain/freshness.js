import { diffDays } from "./dates.js";

/**
 * Staleness of the sales data behind a suggestion. Pure: `today` is injected.
 * stale = (today - dataAsOf) in days > staleAfterDays; missing data is always stale.
 */
export function computeFreshness({ dataAsOf, today, staleAfterDays }) {
  if (!dataAsOf) {
    return { dataAsOf: null, stale: true, notice: "No sales data available; the suggestion cannot be based on recent sales." };
  }
  const age = diffDays(today, dataAsOf);
  if (age <= staleAfterDays) return { dataAsOf, stale: false, notice: null };
  return { dataAsOf, stale: true, notice: `Sales data is ${age} days old (last data: ${dataAsOf}); the suggestion may be outdated.` };
}
