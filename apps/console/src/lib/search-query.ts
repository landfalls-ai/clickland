/** Helpers for the search language (libs/query/src/parse.ts). */

/** A value as the language reads it: bare when it is one simple token, quoted otherwise. */
export function quoteValue(value: string): string {
  if (/^[\w.\-@/:]+$/.test(value) && !/^(AND|OR|NOT)$/i.test(value) && !value.endsWith(':')) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `field:value`, quoted as needed. */
export const fieldClause = (field: string, value: string) => `${field}:${quoteValue(value)}`;

/** Adds a clause to a query (ANDed), unless the query already has it; `exclude` adds `-field:value`. */
export function addClause(query: string, field: string, value: string, exclude = false): string {
  const clause = `${exclude ? '-' : ''}${fieldClause(field, value)}`;
  const q = query.trim();
  if (!q) return clause;
  if (q.split(/\s+/).includes(clause)) return q;
  return `${q} ${clause}`;
}

export const SYNTAX_HELP: Array<{ example: string; meaning: string }> = [
  { example: 'timeout', meaning: 'A word anywhere in the body (the span name for traces)' },
  { example: '"connection refused"', meaning: 'A phrase' },
  { example: 'time*', meaning: 'A wildcard: prefix, suffix or infix' },
  { example: 'level:error', meaning: 'A field equals a value' },
  { example: 'http.status_code:>=500', meaning: 'A comparison (>, >=, <, <=)' },
  { example: 'k8s.pod.name:*', meaning: 'The field exists' },
  { example: 'service:api AND NOT level:debug', meaning: 'AND, OR, NOT and (parentheses)' },
  { example: '-level:debug', meaning: '“-” is NOT' },
  { example: 'duration:>500', meaning: 'Traces: spans slower than 500 ms' },
];
