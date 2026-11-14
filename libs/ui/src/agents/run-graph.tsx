/**
 * One agent run's decision path (`RunGraphResponse`): a vertical tree on a phone or in a narrow card, and the same
 * nodes laid out left to right by depth, joined by the edges, when the container is wide.
 */
import { Bot, Circle, GitBranch, type LucideIcon, Sparkles, Wrench } from 'lucide-react';
import type { RunGraphNode, RunGraphNodeKind, RunGraphResponse } from '@clickland/contracts';
import { cn } from '../cn';
import { Badge } from '../primitives/badge';
import { formatMoney, formatRunDuration, formatTokens } from './format';

export const NODE_ICON: Record<RunGraphNodeKind, LucideIcon> = {
  agent: Bot,
  subagent: GitBranch,
  model: Sparkles,
  tool: Wrench,
  span: Circle,
};

function NodeFace({ node, className }: { node: RunGraphNode; className?: string }) {
  const Icon = NODE_ICON[node.kind] ?? Circle;
  const error = node.status === 'error';
  return (
    <span className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon
          className={cn('size-3.5 shrink-0', error ? 'text-rd' : node.kind === 'model' ? 'text-ac' : 'text-t2')}
          strokeWidth={1.9}
          aria-label={node.kind}
        />
        <span className={cn('min-w-0 truncate text-[12px] font-semibold', error ? 'text-rd' : 'text-t1')}>
          {node.label}
        </span>
        {node.retry && (
          <Badge tone="warning" className="px-1.5">
            retry
          </Badge>
        )}
        {node.loop && (
          <Badge tone="danger" className="px-1.5">
            loop
          </Badge>
        )}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 font-mono text-[11px] text-t3">
        <span>{formatRunDuration(node.durationMs)}</span>
        {node.kind === 'model' && (
          <>
            <span>
              {formatTokens(node.inputTokens)}→{formatTokens(node.outputTokens)} tok
            </span>
            <span>{formatMoney(node.costUsd, 'USD', { cost: true })}</span>
          </>
        )}
        {node.hiddenSpans > 0 && <span>+{node.hiddenSpans} spans</span>}
      </span>
    </span>
  );
}

/** The phone tree: one row per node in the order returned, indented by depth, with a line to its parent. */
export function RunTree({
  graph,
  onSelect,
  className,
}: {
  graph: RunGraphResponse;
  onSelect?: (node: RunGraphNode) => void;
  className?: string;
}) {
  const step = 14;
  return (
    <ol className={cn('flex flex-col', className)} data-testid="run-tree">
      {graph.nodes.map((node) => {
        const error = node.status === 'error';
        return (
          <li key={node.id} className="relative" style={{ paddingLeft: node.depth * step }}>
            {node.depth > 0 && (
              <span
                aria-hidden
                className="absolute bottom-1/2 top-0 border-b border-l border-bd"
                style={{ left: (node.depth - 1) * step + 6, width: step - 6 }}
              />
            )}
            {Array.from({ length: Math.max(0, node.depth - 1) }, (_, i) => (
              <span
                key={i}
                aria-hidden
                className="absolute inset-y-0 border-l border-hair"
                style={{ left: i * step + 6 }}
              />
            ))}
            <button
              type="button"
              disabled={!onSelect}
              onClick={() => onSelect?.(node)}
              className={cn(
                'my-0.5 flex w-full min-w-0 items-center rounded-lg border px-2 py-1.5 text-left transition-colors',
                error ? 'border-rdbd bg-rddim' : 'border-transparent hover:border-hair hover:bg-sf2',
                !onSelect && 'cursor-default',
              )}
            >
              <NodeFace node={node} />
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const W = 216;
const H = 50;
const GAP_X = 36;
const GAP_Y = 10;

/** Positions for the wide layout: x by depth; leaves take the next row, a parent sits level with its first child. */
export function layoutRunGraph(graph: RunGraphResponse): {
  pos: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
} {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const children = new Map<string, RunGraphNode[]>();
  const roots: RunGraphNode[] = [];
  for (const n of graph.nodes) {
    if (n.parentId && ids.has(n.parentId)) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
    else roots.push(n);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let row = 0;
  let maxDepth = 0;
  const place = (node: RunGraphNode, depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    const y = row;
    const kids = children.get(node.id) ?? [];
    if (!kids.length) row += 1;
    for (const kid of kids) place(kid, depth + 1);
    pos.set(node.id, { x: depth * (W + GAP_X), y: y * (H + GAP_Y) });
  };
  for (const r of roots) place(r, 0);
  return { pos, width: (maxDepth + 1) * (W + GAP_X) - GAP_X, height: Math.max(1, row) * (H + GAP_Y) - GAP_Y };
}

/** The wide graph: columns by depth, an elbow line from each step to the step that called it. */
export function RunGraphWide({
  graph,
  onSelect,
  className,
}: {
  graph: RunGraphResponse;
  onSelect?: (node: RunGraphNode) => void;
  className?: string;
}) {
  const { pos, width, height } = layoutRunGraph(graph);
  return (
    <div className={cn('overflow-x-auto', className)} data-testid="run-graph-wide">
      <div className="relative" style={{ width, height }}>
        <svg className="absolute inset-0 overflow-visible" width={width} height={height} aria-hidden>
          {graph.edges.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + W;
            const y1 = a.y + H / 2;
            const x2 = b.x;
            const y2 = b.y + H / 2;
            const mid = x1 + (x2 - x1) / 2;
            return (
              <path
                key={`${e.from}-${e.to}`}
                d={`M${x1},${y1} H${mid} V${y2} H${x2}`}
                fill="none"
                stroke="var(--color-bd, currentColor)"
                strokeWidth={1.2}
              />
            );
          })}
        </svg>
        {graph.nodes.map((node) => {
          const p = pos.get(node.id);
          if (!p) return null;
          const error = node.status === 'error';
          return (
            <button
              key={node.id}
              type="button"
              disabled={!onSelect}
              onClick={() => onSelect?.(node)}
              className={cn(
                'absolute flex items-center rounded-xl border bg-sf px-2.5 text-left shadow-sm transition-colors',
                error ? 'border-rdbd bg-rddim' : 'border-hair hover:border-bd',
                !onSelect && 'cursor-default',
              )}
              style={{ left: p.x, top: p.y, width: W, height: H }}
            >
              <NodeFace node={node} className="w-full" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The tree in a narrow container, the wide graph from 48rem of container width (`wide: false` keeps the tree). */
export function RunGraph({
  graph,
  onSelect,
  wide = true,
}: {
  graph: RunGraphResponse;
  onSelect?: (node: RunGraphNode) => void;
  wide?: boolean;
}) {
  if (!graph.nodes.length) return <p className="text-[13px] text-t3">No agent steps in this trace.</p>;
  if (!wide) return <RunTree graph={graph} onSelect={onSelect} />;
  return (
    <div className="@container">
      <RunTree graph={graph} onSelect={onSelect} className="@3xl:hidden" />
      <RunGraphWide graph={graph} onSelect={onSelect} className="hidden @3xl:block" />
    </div>
  );
}
