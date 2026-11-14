#!/usr/bin/env node
// Writes the starting price table (Anthropic's list prices for the Claude models) and the starting outcome
// definitions for agent value (docs/agent-value.md), through the API. Safe to run again: it adds what is missing,
// refreshes seeded rows nobody changed, and leaves every row a person edited alone.
//
//   node scripts/seed-agent-value.mjs
//
// CLICKLAND_API_URL (default http://127.0.0.1:4710) is the API. CLICKLAND_API_KEY is an admin key; without one the
// call relies on CLICKLAND_AUTH=dev (local only). The rows themselves live in apps/api/src/value.ts.
const API = (process.env.CLICKLAND_API_URL ?? 'http://127.0.0.1:4710').replace(/\/$/, '');
const key = process.env.CLICKLAND_API_KEY;

const response = await fetch(`${API}/api/value/seed`, {
  method: 'POST',
  headers: key ? { authorization: `Bearer ${key}` } : {},
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`Seed failed (${response.status}): ${body?.error?.message ?? 'no message'}`);
  if (response.status === 404) console.error('This API has no /api/value/seed: is it running the agent-value build?');
  process.exit(1);
}
const line = (name, r) => `${name}: ${r.added} added, ${r.refreshed} refreshed, ${r.kept} kept as edited`;
console.log(line('Prices', body.prices));
console.log(line('Outcomes', body.outcomes));
