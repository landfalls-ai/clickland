/** Builds a trace's span tree and its critical numbers from flat span rows. */

export interface SpanLike {
  spanId: string;
  parentSpanId: string;
  startNs: bigint;
  durationNs: bigint;
  status: string;
  service: string;
}

export interface TraceNode<S extends SpanLike> {
  span: S;
  depth: number;
  children: TraceNode<S>[];
}

export interface TraceSummary<S extends SpanLike> {
  roots: TraceNode<S>[];
  /** Spans in display order: depth first, children by start time. */
  ordered: { span: S; depth: number }[];
  startNs: bigint;
  durationNs: bigint;
  services: string[];
  errorCount: number;
}

export const isErrorStatus = (status: string) => /error/i.test(status) || status === 'STATUS_CODE_ERROR';

export function buildTrace<S extends SpanLike>(spans: S[]): TraceSummary<S> {
  const nodes = new Map<string, TraceNode<S>>();
  for (const span of spans) nodes.set(span.spanId, { span, depth: 0, children: [] });
  const roots: TraceNode<S>[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parentSpanId ? nodes.get(node.span.parentSpanId) : undefined;
    // A missing parent (not yet ingested, or sampled out) makes the span a root, so nothing is hidden.
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const byStart = (a: TraceNode<S>, b: TraceNode<S>) =>
    a.span.startNs < b.span.startNs ? -1 : a.span.startNs > b.span.startNs ? 1 : 0;
  roots.sort(byStart);
  const ordered: { span: S; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (node: TraceNode<S>, depth: number) => {
    if (seen.has(node.span.spanId)) return; // a cycle in bad data
    seen.add(node.span.spanId);
    node.depth = depth;
    ordered.push({ span: node.span, depth });
    node.children.sort(byStart);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);

  let start = spans.length ? spans[0]!.startNs : 0n;
  let end = start;
  for (const s of spans) {
    if (s.startNs < start) start = s.startNs;
    const e = s.startNs + s.durationNs;
    if (e > end) end = e;
  }
  return {
    roots,
    ordered,
    startNs: start,
    durationNs: end - start,
    services: [...new Set(spans.map((s) => s.service))].sort(),
    errorCount: spans.filter((s) => isErrorStatus(s.status)).length,
  };
}
