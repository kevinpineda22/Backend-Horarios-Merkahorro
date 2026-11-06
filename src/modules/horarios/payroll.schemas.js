import { z } from "zod";

const text = z.string().trim();

// Only the shape is checked here: whether [from, to] is a valid payroll cut (Monday start,
// 7 or 14 days) is decided by the service, which answers 400 PAYROLL_PERIOD_INVALID.
// Both dates or neither: the service then falls back to the default period.
export const reportQuerySchema = z.object({
  from: text.optional(),
  to: text.optional(),
  sedeId: text.min(1, "Sede inválida").optional(),
});
