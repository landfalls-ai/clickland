import { parseSearch, type SearchNode } from './parse.js';
import { DURATION_NS_PER_MS, type MapColumn, type NativeColumn, type SignalSchema } from './signals.js';

/**
 * Turns a search into a ClickHouse WHERE clause that the table's indexes can serve (research.md §3, decision D4):
 *
 * - a bare word        → hasAllTokens(lower(Body), [tokens])   text index, direct read (count() answered from it)
 * - a phrase           → hasPhrase(lower(Body), 'a b')          text index
 * - a word with . - /  → lower(Body) LIKE '%a-b%'               text index (tokens taken from the pattern)
 * - attr:value         → has(LogAttributeItems, 'attr=value')   text index on the key=value items
 * - attr:*             → mapContains(LogAttributes, 'attr')     text index on the map keys
 * - k8s.pod.name:x     → the MATERIALIZED column instead of the map
 * - trace_id:x         → TraceId = 'x'                          text index on TraceId
 *
 * Every value the user typed is a query parameter (`{p0:String}`); every identifier comes from the signal schema.
 * The integration tests check each shape with EXPLAIN indexes=1 against a real server.
 */

export type ParamValue = string | number | string[];

export interface CompiledFilter {
  sql: string;
  params: Record<string, ParamValue>;
}

export class SearchFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchFieldError';
  }
}

/** ClickHouse's `splitByNonAlpha`: ASCII letters and digits make tokens; bytes above 0x7F stay inside tokens. */
export function splitByNonAlpha(text: string): string[] {
  // eslint-disable-next-line no-control-regex -- ClickHouse's separators are every ASCII byte that isn't a letter or digit.
  return text.split(/[\x00-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/).filter((t) => t.length > 0);
}

const MAX_TOKENS = 64; // hasAllTokens takes at most 64 tokens (ClickStack, queryParser.ts:31)

/** Columns whose values people type in any case: `level:ERROR` finds `error`. */
const CASE_INSENSITIVE = new Set(['SeverityText', 'StatusCode', 'SpanKind']);

export const quoteIdentifier = (name: string) => {
  if (!/^[A-Za-z_][\w.]*$/.test(name)) throw new Error(`Not an identifier: ${name}`);
  return `\`${name}\``;
};

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** `foo*bar` → `foo%bar`, with the literal parts escaped. */
const wildcardToLike = (s: string) => s.split('*').map(likeEscape).join('%');

class Compiler {
  readonly params: Record<string, ParamValue> = {};
  private next = 0;

  constructor(
    private readonly schema: SignalSchema,
    private readonly prefix: string,
  ) {}

  param(value: ParamValue, type: string): string {
    const name = `${this.prefix}${this.next++}`;
    this.params[name] = value;
    return `{${name}:${type}}`;
  }

  node(n: SearchNode): string {
    switch (n.type) {
      case 'and':
        return n.children.map((c) => this.wrap(c)).join(' AND ');
      case 'or':
        return n.children.map((c) => this.wrap(c)).join(' OR ');
      case 'not':
        return `NOT ${this.wrap(n.child)}`;
      case 'match':
        return n.field === null ? this.implicit(n.value, n.kind) : this.field(n.field, n);
      case 'exists':
        return this.field(n.field, n);
      case 'compare':
        return this.field(n.field, n);
    }
  }

  private wrap(n: SearchNode): string {
    const sql = this.node(n);
    return n.type === 'and' || n.type === 'or' ? `(${sql})` : sql;
  }

  private implicit(value: string, kind: 'word' | 'phrase' | 'wildcard'): string {
    const expr = this.schema.implicit.indexedExpression;
    const lowered = value.toLowerCase();
    if (kind === 'wildcard') return `${expr} LIKE ${this.param(`%${wildcardToLike(lowered)}%`, 'String')}`;
    const tokens = splitByNonAlpha(lowered);
    if (tokens.length === 0) {
      // Only punctuation: a plain substring search (no token can narrow it).
      return `${expr} LIKE ${this.param(`%${likeEscape(lowered)}%`, 'String')}`;
    }
    if (kind === 'phrase' && tokens.length > 1) return `hasPhrase(${expr}, ${this.param(lowered, 'String')})`;
    if (tokens.length === 1 && tokens[0] === lowered) {
      return `hasAllTokens(${expr}, ${this.param(tokens, 'Array(String)')})`;
    }
    if (tokens.length > MAX_TOKENS) throw new SearchFieldError(`A term has more than ${MAX_TOKENS} words`);
    // `connection-refused`, `a.b.c`: an exact substring; LIKE still uses the text index through its tokens.
    return `${expr} LIKE ${this.param(`%${likeEscape(lowered)}%`, 'String')}`;
  }

  private field(name: string, n: Extract<SearchNode, { type: 'match' | 'exists' | 'compare' }>): string {
    const native = this.schema.native[name];
    if (native) return this.nativeField(native, n);
    const materialized = this.schema.materialized[name];
    if (materialized) return this.materializedField(materialized.column, n);
    for (const map of this.schema.maps) {
      const prefix = map.prefixes.find((p) => name.startsWith(`${p}.`));
      if (prefix) {
        const key = name.slice(prefix.length + 1);
        const viaMaterialized = Object.values(this.schema.materialized).find(
          (m) => m.map === map.column && m.key === key,
        );
        return viaMaterialized ? this.materializedField(viaMaterialized.column, n) : this.mapField(map, key, n);
      }
    }
    // Neither native nor prefixed: the key may sit in any of the maps.
    const parts = this.schema.maps.map((map) => this.mapField(map, name, n));
    return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
  }

  private nativeField(col: NativeColumn, n: Extract<SearchNode, { type: 'match' | 'exists' | 'compare' }>): string {
    const c = quoteIdentifier(col.column);
    if (n.type === 'exists') return col.kind === 'string' ? `${c} != ''` : 'true';
    if (col.kind === 'number' || col.kind === 'datetime') {
      if (n.type === 'match' && n.kind === 'wildcard')
        throw new SearchFieldError(`${col.column} takes a number, not a pattern`);
      const op = n.type === 'compare' ? n.op : '=';
      if (col.kind === 'datetime')
        return `${c} ${op} parseDateTime64BestEffort(${this.param(n.value, 'String')}, 9, 'UTC')`;
      const value = Number(n.value);
      if (!Number.isFinite(value)) throw new SearchFieldError(`${col.column} takes a number, got "${n.value}"`);
      const scaled = col.column === 'Duration' ? Math.round(value * DURATION_NS_PER_MS) : value;
      return `${c} ${op} ${this.param(scaled, 'Float64')}`;
    }
    if (n.type === 'compare') return `${c} ${n.op} ${this.param(n.value, 'String')}`;
    const ci = CASE_INSENSITIVE.has(col.column);
    if (n.kind === 'wildcard') return `${c} ${ci ? 'ILIKE' : 'LIKE'} ${this.param(wildcardToLike(n.value), 'String')}`;
    return ci
      ? `lower(${c}) = ${this.param(n.value.toLowerCase(), 'String')}`
      : `${c} = ${this.param(n.value, 'String')}`;
  }

  private materializedField(column: string, n: Extract<SearchNode, { type: 'match' | 'exists' | 'compare' }>): string {
    const c = quoteIdentifier(column);
    if (n.type === 'exists') return `${c} != ''`;
    if (n.type === 'compare') return `toFloat64OrNull(${c}) ${n.op} ${this.param(Number(n.value), 'Float64')}`;
    if (n.kind === 'wildcard') return `${c} LIKE ${this.param(wildcardToLike(n.value), 'String')}`;
    return `${c} = ${this.param(n.value, 'String')}`;
  }

  private mapField(
    map: MapColumn,
    key: string,
    n: Extract<SearchNode, { type: 'match' | 'exists' | 'compare' }>,
  ): string {
    const m = quoteIdentifier(map.column);
    if (n.type === 'match' && n.kind !== 'wildcard') {
      // Exact value: the key=value items index answers it.
      return `has(${quoteIdentifier(map.items)}, ${this.param(`${key}=${n.value}`, 'String')})`;
    }
    const k = this.param(key, 'String');
    if (n.type === 'exists') return `mapContains(${m}, ${k})`;
    if (n.type === 'compare') {
      const value = Number(n.value);
      if (!Number.isFinite(value))
        return `(mapContains(${m}, ${k}) AND ${m}[${k}] ${n.op} ${this.param(n.value, 'String')})`;
      return `(mapContains(${m}, ${k}) AND toFloat64OrNull(${m}[${k}]) ${n.op} ${this.param(value, 'Float64')})`;
    }
    return `(mapContains(${m}, ${k}) AND ${m}[${k}] LIKE ${this.param(wildcardToLike(n.value), 'String')})`;
  }
}

/**
 * Compiles a search; an empty search matches everything (`sql` is `true`). `paramPrefix` keeps the parameter names of
 * several filters in one query apart.
 */
export function compileSearch(schema: SignalSchema, query: string, paramPrefix = 'p'): CompiledFilter {
  if (!/^[a-z]+$/.test(paramPrefix)) throw new Error(`Bad parameter prefix: ${paramPrefix}`);
  const tree = parseSearch(query);
  const compiler = new Compiler(schema, paramPrefix);
  return { sql: tree ? compiler.node(tree) : 'true', params: compiler.params };
}
