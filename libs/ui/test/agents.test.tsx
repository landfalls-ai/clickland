import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Panel, type RunGraphNode, type RunGraphResponse, type ValueReportResponse } from '@clickland/contracts';
import { agentIdOf, formatMoney, formatRoi, formatRunDuration, formatTokens } from '../src/agents/format';
import { layoutRunGraph, RunTree } from '../src/agents/run-graph';
import type { DataSource } from '../src/data';
import { PanelView } from '../src/panels/panel-view';

const range = { from: '2026-11-14T14:00:00.000Z', to: '2026-11-14T15:00:00.000Z' };

const node = (id: string, parentId: string | null, depth: number, extra: Partial<RunGraphNode> = {}): RunGraphNode => ({
  id,
  parentId,
  kind: 'tool',
  label: id,
  service: 's',
  spanName: id,
  depth,
  offsetMs: 0,
  durationMs: 100,
  status: 'ok',
  errorType: '',
  statusMessage: '',
  model: '',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  costHow: '',
  tool: '',
  toolKind: '',
  agent: '',
  retry: false,
  loop: false,
  hiddenSpans: 0,
  ...extra,
});

const graph = (nodes: RunGraphNode[]): RunGraphResponse => ({
  traceId: 'abc',
  startedAt: range.from,
  durationMs: 1000,
  nodes,
  edges: nodes.filter((n) => n.parentId).map((n) => ({ from: n.parentId!, to: n.id })),
  summary: {
    agents: [],
    agentRuns: 1,
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    errors: 0,
    retries: 0,
    spans: nodes.length,
    services: [],
  },
  loops: [],
});

describe('agent formatting', () => {
  it('money, ROI, durations and tokens follow the console spec', () => {
    expect(formatMoney(184.15)).toBe('$184.15');
    expect(formatMoney(0.0422, 'USD', { cost: true })).toBe('$0.0422');
    expect(formatMoney(12.5, 'USD', { cost: true })).toBe('$12.50');
    expect(formatRoi(216.1616)).toBe('21,616%');
    expect(formatRoi(null)).toBe('—');
    expect(formatRunDuration(904)).toBe('904 ms');
    expect(formatRunDuration(3456)).toBe('3.5 s');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(9500)).toBe('9.5k');
    expect(formatTokens(480_000)).toBe('480k');
  });

  it('builds the same agent id as the API (ag_ + base64url of service/name)', () => {
    expect(agentIdOf('demo-landflow-host/Support triage')).toBe('ag_ZGVtby1sYW5kZmxvdy1ob3N0L1N1cHBvcnQgdHJpYWdl');
  });
});

describe('run graph', () => {
  it('lays out by depth: leaves take rows, a parent sits level with its first child', () => {
    const { pos, width, height } = layoutRunGraph(
      graph([node('a', null, 0), node('b', 'a', 1), node('c', 'a', 1), node('d', 'c', 2), node('e', 'c', 2)]),
    );
    expect(pos.get('a')!.y).toBe(pos.get('b')!.y);
    expect(pos.get('c')!.y).toBe(pos.get('d')!.y);
    expect(pos.get('e')!.y).toBeGreaterThan(pos.get('d')!.y);
    expect(pos.get('d')!.x).toBeGreaterThan(pos.get('c')!.x);
    expect(width).toBeGreaterThan(0);
    expect(height).toBe(3 * 50 + 2 * 10);
  });

  it('the phone tree shows every node with its badges', () => {
    render(
      <RunTree
        graph={graph([
          node('agent', null, 0, { kind: 'agent' }),
          node('fetch', 'agent', 1, { loop: true, retry: true }),
        ])}
      />,
    );
    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('loop')).toBeInTheDocument();
    expect(screen.getByText('retry')).toBeInTheDocument();
  });
});

describe('agent panels', () => {
  const report: ValueReportResponse = {
    from: range.from,
    to: range.to,
    currency: 'USD',
    hourlyRate: 60,
    model: 'm',
    totals: {
      value: 25,
      cost: 0.05,
      net: 24.95,
      roi: 499,
      outcomes: 5,
      costPerOutcome: 0.01,
      how: { net: 'n', roi: 'r', costPerOutcome: 'c' },
    },
    agents: ['A', 'B', 'C', 'D'].map((name) => ({
      key: `svc/${name}`,
      name,
      service: 'svc',
      family: 'landflow',
      seen: true,
      costHow: '',
      lines: [],
      value: 1,
      cost: 0,
      net: 1,
      roi: null,
      outcomes: 1,
      costPerOutcome: null,
      how: { net: '', roi: '', costPerOutcome: '' },
    })),
    teams: [],
    outcomes: [],
    unattributed: { outcomes: 0, value: 0, note: '' },
    truncated: false,
  };

  it('agent_value at half width shows the hero and the top three agents', async () => {
    const data = { agentValue: async () => report } as unknown as DataSource;
    render(<PanelView panel={Panel.parse({ type: 'agent_value', title: 'Value' })} range={range} data={data} />);
    expect(await screen.findByTestId('value-hero')).toHaveTextContent('$24.95');
    expect(screen.getAllByTestId('value-agent-card')).toHaveLength(3);
    expect(screen.getByText('and 1 more agents')).toBeInTheDocument();
  });

  it('a data source without agent methods says the panel is not supported', () => {
    render(
      <PanelView panel={Panel.parse({ type: 'agents', title: 'Agents' })} range={range} data={{} as DataSource} />,
    );
    expect(screen.getByText('This panel type isn’t supported here.')).toBeInTheDocument();
  });
});
