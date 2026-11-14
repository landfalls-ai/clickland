/**
 * The Clickland search language: a small Lucene-like language, the same shape ClickStack's search box takes.
 *
 *   timeout                       a word anywhere in the body (span name for traces)
 *   "connection refused"          a phrase
 *   time*                         a wildcard (prefix, suffix or infix)
 *   level:error                   a field equals a value
 *   http.status_code:>=500        a comparison
 *   k8s.pod.name:*                the field exists
 *   service:api AND NOT level:debug OR (a b)
 *   -level:debug                  "-" is NOT
 *
 * Adjacent clauses are ANDed. AND binds tighter than OR.
 */

export type Comparison = '>' | '>=' | '<' | '<=';

export type SearchNode =
  | { type: 'and'; children: SearchNode[] }
  | { type: 'or'; children: SearchNode[] }
  | { type: 'not'; child: SearchNode }
  | { type: 'match'; field: string | null; value: string; kind: 'word' | 'phrase' | 'wildcard' }
  | { type: 'exists'; field: string }
  | { type: 'compare'; field: string; op: Comparison; value: string };

export class SearchSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} (at character ${position + 1})`);
    this.name = 'SearchSyntaxError';
  }
}

type Token =
  | { kind: 'lparen' | 'rparen' | 'and' | 'or' | 'not' | 'minus'; pos: number }
  | { kind: 'phrase'; value: string; pos: number }
  | { kind: 'text'; value: string; pos: number };

const MAX_LENGTH = 4000;
const MAX_DEPTH = 32;

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '(' || c === ')') {
      tokens.push({ kind: c === '(' ? 'lparen' : 'rparen', pos: i });
      i++;
    } else if (c === '"') {
      const start = i;
      let value = '';
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) i++;
        value += input[i];
        i++;
      }
      if (i >= input.length) throw new SearchSyntaxError('A quote is not closed', start);
      i++;
      tokens.push({ kind: 'phrase', value, pos: start });
    } else if (c === '-' && (tokens.length === 0 || /[\s(]/.test(input[i - 1] ?? ' '))) {
      tokens.push({ kind: 'minus', pos: i });
      i++;
    } else {
      const start = i;
      let value = '';
      // A field:"quoted value" keeps its quotes inside the text token so the parser can split it.
      while (i < input.length && !/[\s()]/.test(input[i]!)) {
        if (input[i] === '\\' && i + 1 < input.length) {
          value += input[i]! + input[i + 1]!;
          i += 2;
        } else if (input[i] === '"' && value.endsWith(':')) {
          const q = i;
          value += '"';
          i++;
          while (i < input.length && input[i] !== '"') {
            if (input[i] === '\\' && i + 1 < input.length) i++;
            value += input[i];
            i++;
          }
          if (i >= input.length) throw new SearchSyntaxError('A quote is not closed', q);
          value += '"';
          i++;
        } else {
          value += input[i];
          i++;
        }
      }
      if (value === 'AND') tokens.push({ kind: 'and', pos: start });
      else if (value === 'OR') tokens.push({ kind: 'or', pos: start });
      else if (value === 'NOT') tokens.push({ kind: 'not', pos: start });
      else tokens.push({ kind: 'text', value, pos: start });
    }
  }
  return tokens;
}

const unescape = (s: string) => s.replace(/\\(.)/g, '$1');

/** A field name: letters, digits, `_`, `.`, `-`, `@`, `/` (OTel attribute keys such as `k8s.pod.name`, `http.route`). */
const FIELD = /^[A-Za-z_@][\w.\-@/]*$/;

function textToNode(token: { value: string; pos: number }): SearchNode {
  const raw = token.value;
  // Find the first unescaped ':' that splits a field from its value.
  let colon = -1;
  for (let j = 0; j < raw.length; j++) {
    if (raw[j] === '\\') {
      j++;
      continue;
    }
    if (raw[j] === ':') {
      colon = j;
      break;
    }
  }
  if (colon > 0 && FIELD.test(raw.slice(0, colon))) {
    const field = raw.slice(0, colon);
    let rest = raw.slice(colon + 1);
    if (rest === '') throw new SearchSyntaxError(`"${field}:" needs a value`, token.pos);
    if (rest === '*') return { type: 'exists', field };
    if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2)
      return { type: 'match', field, value: rest.slice(1, -1), kind: 'phrase' };
    const op = (['>=', '<=', '>', '<'] as const).find((o) => rest.startsWith(o));
    if (op) {
      rest = rest.slice(op.length);
      if (rest === '') throw new SearchSyntaxError(`"${field}:${op}" needs a value`, token.pos);
      return { type: 'compare', field, op, value: unescape(rest) };
    }
    return { type: 'match', field, value: unescape(rest), kind: /(?<!\\)\*/.test(rest) ? 'wildcard' : 'word' };
  }
  return { type: 'match', field: null, value: unescape(raw), kind: /(?<!\\)\*/.test(raw) ? 'wildcard' : 'word' };
}

export function parseSearch(input: string): SearchNode | null {
  if (input.length > MAX_LENGTH)
    throw new SearchSyntaxError(`A search is at most ${MAX_LENGTH} characters`, MAX_LENGTH);
  const tokens = lex(input);
  if (tokens.length === 0) return null;
  let at = 0;
  const peek = () => tokens[at];

  const parseOr = (depth: number): SearchNode => {
    const children = [parseAnd(depth)];
    while (peek()?.kind === 'or') {
      at++;
      children.push(parseAnd(depth));
    }
    return children.length === 1 ? children[0]! : { type: 'or', children };
  };

  const parseAnd = (depth: number): SearchNode => {
    const children = [parseUnary(depth)];
    for (;;) {
      const next = peek();
      if (!next || next.kind === 'or' || next.kind === 'rparen') break;
      if (next.kind === 'and') at++;
      children.push(parseUnary(depth));
    }
    return children.length === 1 ? children[0]! : { type: 'and', children };
  };

  const parseUnary = (depth: number): SearchNode => {
    if (depth > MAX_DEPTH) throw new SearchSyntaxError('The search nests too deeply', peek()?.pos ?? input.length);
    const token = peek();
    if (!token) throw new SearchSyntaxError('The search ends too early', input.length);
    if (token.kind === 'not' || token.kind === 'minus') {
      at++;
      return { type: 'not', child: parseUnary(depth + 1) };
    }
    if (token.kind === 'lparen') {
      at++;
      const inner = parseOr(depth + 1);
      if (peek()?.kind !== 'rparen') throw new SearchSyntaxError('A bracket is not closed', token.pos);
      at++;
      return inner;
    }
    if (token.kind === 'phrase') {
      at++;
      return { type: 'match', field: null, value: token.value, kind: 'phrase' };
    }
    if (token.kind === 'text') {
      at++;
      return textToNode(token);
    }
    throw new SearchSyntaxError(`Unexpected ${token.kind.toUpperCase()}`, token.pos);
  };

  const tree = parseOr(0);
  const left = peek();
  if (left) throw new SearchSyntaxError(`Unexpected ${left.kind === 'rparen' ? '")"' : left.kind}`, left.pos);
  return tree;
}
