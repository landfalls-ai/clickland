/** `[[clickland:view:vw_…]]` markers in an assistant answer: each one shows that view inline. */

export type Segment = { type: 'text'; text: string } | { type: 'view'; id: string };

const MARKER = /\[\[clickland:view:(vw_[A-Za-z0-9]+)\]\]/g;
/** A marker still arriving at the end of a streamed answer: hidden until it is whole. */
const PARTIAL = /\[(\[(c(l(i(c(k(l(a(n(d(:(v(i(e(w(:(v(w(_[A-Za-z0-9]*)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?$/;

export function splitMarkers(text: string, streaming = false): Segment[] {
  const source = streaming ? text.replace(PARTIAL, '') : text;
  const out: Segment[] = [];
  let last = 0;
  for (const m of source.matchAll(MARKER)) {
    if (m.index! > last) out.push({ type: 'text', text: source.slice(last, m.index) });
    out.push({ type: 'view', id: m[1]! });
    last = m.index! + m[0].length;
  }
  if (last < source.length) out.push({ type: 'text', text: source.slice(last) });
  return out.filter((s) => s.type === 'view' || s.text.trim());
}

/** Every view id in an answer, once each, in order. */
export const viewIds = (text: string) => [...new Set([...text.matchAll(MARKER)].map((m) => m[1]!))];
