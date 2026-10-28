# sugerido (suggested schedule)

**Status: pending business definition. No code yet.**

This module will produce a suggested shift schedule for cashiers. HOW it is
calculated has not been defined by the business, so nothing is implemented:
no routes, tables, SQL, rules or algorithms.

Open questions for the business (inputs are unknown), for example:

- Is the suggestion driven by hourly demand (sales/traffic per hour), by fixed
  staffing per sede, or by something else?
- Which constraints apply (labor rules, breaks, contracts, availability)?
- What is the output granularity (per day, per shift, per hour)?

Once defined, add `sugerido.routes.js` here and mount it in `src/routes.js`
behind `authenticate`.
