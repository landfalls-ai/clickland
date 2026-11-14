import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from '@clickland/ui';
import { landVariables } from '../src/host-theme';
import { mcpDataSource } from '../src/mcp-data';
import { viewFromToolResult } from '../src/tool-result';
import { ViewScreen } from '../src/view-screen';

const spec = { title: 'Checkout', range: { lastMinutes: 60 }, panels: [{ type: 'markdown', title: 'Finding', text: 'Hi' }] };

describe('viewFromToolResult', () => {
  it('reads a view from render_view / get_view', () => {
    const view = viewFromToolResult({
      name: 'render_view',
      result: { structuredContent: { id: 'vw_1', url: 'http://127.0.0.1:4711/views/vw_1', spec } },
    });
    expect(view.id).toBe('vw_1');
    expect(view.url).toBe('http://127.0.0.1:4711/views/vw_1');
    expect(view.spec.panels[0]!.width).toBe('half');
  });

  it('reads a view from JSON text when there is no structured content', () => {
    const view = viewFromToolResult({
      name: 'get_view',
      result: { content: [{ type: 'text', text: JSON.stringify({ id: 'vw_2', pinned: true, spec }) }] },
    });
    expect(view).toMatchObject({ id: 'vw_2', pinned: true });
  });

  it('turns a search_logs result into a one-panel logs view of the same query', () => {
    const view = viewFromToolResult({
      name: 'search_logs',
      arguments: { signal: 'logs', query: 'level:error', from: '2026-11-14T14:00:00.000Z', to: '2026-11-14T15:00:00.000Z', limit: 20 },
      result: { structuredContent: { rows: [], nextCursor: null } },
    });
    expect(view.id).toBeNull();
    expect(view.spec.range).toEqual({ from: '2026-11-14T14:00:00.000Z', to: '2026-11-14T15:00:00.000Z' });
    expect(view.spec.panels[0]).toMatchObject({ type: 'logs', query: 'level:error', limit: 20, width: 'full' });
  });

  it('turns search_traces, get_trace, list_services and query_metric into their panels', () => {
    const r = { structuredContent: {} };
    expect(viewFromToolResult({ name: 'search_traces', arguments: { query: 'x' }, result: r }).spec.panels[0]!.type).toBe('spans');
    expect(
      viewFromToolResult({ name: 'get_trace', result: { structuredContent: { traceId: 'abc', spans: [] } } }).spec.panels[0],
    ).toMatchObject({ type: 'trace', traceId: 'abc' });
    expect(viewFromToolResult({ name: 'list_services', result: { structuredContent: { services: [] } } }).spec.panels[0]!.type).toBe('services');
    expect(
      viewFromToolResult({
        name: 'query_metric',
        arguments: { metric: 'http.server.duration', type: 'histogram', aggregation: 'p95' },
        result: r,
      }).spec.panels[0],
    ).toMatchObject({ type: 'metric', metric: 'http.server.duration', metricType: 'histogram', aggregation: 'p95' });
  });

  it('reports a tool error', () => {
    expect(() => viewFromToolResult({ name: 'get_view', result: { isError: true, content: [{ type: 'text', text: 'not_found' }] } })).toThrow('not_found');
  });
});

describe('mcpDataSource', () => {
  it('maps each method to its MCP tool', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const data = mcpDataSource(async (name, args) => {
      calls.push([name, args]);
      if (name === 'list_services') return { structuredContent: { services: [{ name: 'api' }] } };
      if (name === 'count') return { content: [{ type: 'text', text: '{"count": 7}' }] };
      return { structuredContent: { rows: [], series: [] } };
    });
    const range = { from: 'a', to: 'b' };
    await data.search({ signal: 'traces', query: 'q', ...range });
    await data.search({ signal: 'logs', query: 'q', ...range });
    await data.histogram({ signal: 'logs', query: 'q', groupBy: 'service', ...range });
    expect(await data.services(range)).toEqual([{ name: 'api' }]);
    expect(await data.total({ signal: 'logs', query: '', ...range })).toBe(7);
    await data.trace('abc');
    await data.patterns({ signal: 'logs', query: '', ...range });
    await data.metric({ metric: 'm', type: 'gauge', aggregation: 'avg', ...range });
    expect(calls.map(([n]) => n)).toEqual([
      'search_traces',
      'search_logs',
      'histogram',
      'list_services',
      'count',
      'get_trace',
      'event_patterns',
      'query_metric',
    ]);
    expect(calls[0]![1]).toEqual({ signal: 'traces', query: 'q', from: 'a', to: 'b' });
  });

  it('throws the tool’s error text', async () => {
    const data = mcpDataSource(async () => ({ isError: true, content: [{ type: 'text', text: 'bad query at 3' }] }));
    await expect(data.trace('x')).rejects.toThrow('bad query at 3');
  });
});

describe('host theme', () => {
  it('maps host variables onto the land tokens and leaves the rest', () => {
    expect(landVariables({ '--color-background-primary': '#111', '--color-text-danger': 'red', '--font-sans': 'Inter' } as never)).toEqual({
      '--bg': '#111',
      '--sf': '#111',
      '--rd': 'red',
      '--font-geist-sans': 'Inter',
    });
    expect(landVariables(undefined)).toEqual({});
  });
});

describe('ViewScreen', () => {
  const data = {} as DataSource;
  const view = viewFromToolResult({ name: 'render_view', result: { structuredContent: { id: 'vw_1', spec } } });

  it('shows Save as dashboard only when the view has an id', () => {
    const onSave = vi.fn();
    const { rerender } = render(<ViewScreen view={view} data={data} save="idle" onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Save as dashboard/ }));
    expect(onSave).toHaveBeenCalled();
    rerender(<ViewScreen view={{ ...view, id: null }} data={data} save="idle" onSave={onSave} />);
    expect(screen.queryByRole('button', { name: /Save as dashboard/ })).toBeNull();
    rerender(<ViewScreen view={view} data={data} save="saved" onSave={onSave} />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('waits for the tool result', () => {
    render(<ViewScreen view={null} data={null} save="idle" />);
    expect(screen.getByTestId('view-loading')).toBeInTheDocument();
  });
});
