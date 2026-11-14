import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Panel, ViewSpec, type PanelInput } from '@clickland/contracts';
import { PanelView } from '../src/panels/panel-view';
import { ViewGrid } from '../src/panels/view-grid';
import { fakeData } from './fixtures';

const range = { from: '2026-11-14T14:00:00.000Z', to: '2026-11-14T15:00:00.000Z' };
const panel = (input: PanelInput) => Panel.parse(input);

describe('PanelView', () => {
  it('timeseries: asks for a histogram with the group-by and draws the legend', async () => {
    const { data, calls } = fakeData();
    render(
      <PanelView
        panel={panel({ type: 'timeseries', title: 'Errors', query: 'level:error', groupBy: 'service' })}
        range={range}
        data={data}
      />,
    );
    expect(await screen.findByTestId('timeseries-chart')).toBeInTheDocument();
    expect(calls[0]).toEqual(['histogram', { signal: 'logs', query: 'level:error', groupBy: 'service', ...range }]);
    const legend = screen.getByTestId('chart-legend');
    expect(within(legend).getByText('api')).toBeInTheDocument();
    expect(within(legend).getByText('10')).toBeInTheDocument(); // total of api
  });

  it('bar: totals per group', async () => {
    const { data } = fakeData();
    render(
      <PanelView panel={panel({ type: 'bar', title: 'By service', groupBy: 'service' })} range={range} data={data} />,
    );
    expect(await screen.findByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.getByText('worker')).toBeInTheDocument();
  });

  it('stat: the total', async () => {
    const { data, calls } = fakeData();
    render(
      <PanelView
        panel={panel({ type: 'stat', title: 'Errors', signal: 'traces', query: 'status:error' })}
        range={range}
        data={data}
      />,
    );
    expect(await screen.findByText('4,321')).toBeInTheDocument();
    expect(calls[0]).toEqual(['total', { signal: 'traces', query: 'status:error', ...range }]);
  });

  it('logs: rows that expand, with a trace link', async () => {
    const { data, calls } = fakeData();
    const openTrace = vi.fn();
    render(
      <PanelView
        panel={panel({ type: 'logs', title: 'Latest', query: 'level:error', limit: 5 })}
        range={range}
        data={data}
        links={{ openTrace }}
      />,
    );
    fireEvent.click(await screen.findByText('log line 1'));
    fireEvent.click(screen.getByRole('button', { name: /abc123/ }));
    expect(openTrace).toHaveBeenCalledWith('abc123');
    expect(calls[0]).toEqual(['search', { signal: 'logs', query: 'level:error', limit: 5, ...range }]);
  });

  it('spans: searches traces', async () => {
    const { data, calls } = fakeData();
    render(
      <PanelView panel={panel({ type: 'spans', title: 'Slow', query: 'duration:>500' })} range={range} data={data} />,
    );
    expect(await screen.findByText('op-s1')).toBeInTheDocument();
    expect(calls[0]![1]).toMatchObject({ signal: 'traces', query: 'duration:>500', limit: 25 });
  });

  it('trace: a waterfall', async () => {
    const { data, calls } = fakeData();
    render(
      <PanelView panel={panel({ type: 'trace', title: 'A trace', traceId: 'abc123' })} range={range} data={data} />,
    );
    expect(await screen.findByTestId('trace-waterfall')).toBeInTheDocument();
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
    expect(calls[0]).toEqual(['trace', 'abc123']);
  });

  it('services: the table, a click opens the service', async () => {
    const { data } = fakeData();
    const openService = vi.fn();
    render(
      <PanelView
        panel={panel({ type: 'services', title: 'Services' })}
        range={range}
        data={data}
        links={{ openService }}
      />,
    );
    fireEvent.click(await screen.findByText('api'));
    expect(openService).toHaveBeenCalledWith('api');
    expect(screen.getByText('1.0%')).toBeInTheDocument();
  });

  it('patterns: templates with highlighted placeholders; a click searches the example', async () => {
    const { data } = fakeData();
    const openSearch = vi.fn();
    render(
      <PanelView
        panel={panel({ type: 'patterns', title: 'Patterns', query: 'level:error' })}
        range={range}
        data={data}
        links={{ openSearch }}
      />,
    );
    const list = await screen.findByTestId('patterns-list');
    expect(list.querySelectorAll('[data-placeholder]')).toHaveLength(2);
    fireEvent.click(within(list).getByRole('button'));
    expect(openSearch).toHaveBeenCalledWith({
      signal: 'logs',
      query: 'level:error "Connection to db refused after 30 ms"',
    });
  });

  it('metric: queries the metric', async () => {
    const { data, calls } = fakeData();
    render(
      <PanelView
        panel={panel({
          type: 'metric',
          title: 'p95',
          metric: 'http.server.duration',
          metricType: 'histogram',
          aggregation: 'p95',
          service: 'api',
        })}
        range={range}
        data={data}
      />,
    );
    expect(await screen.findByTestId('timeseries-chart')).toBeInTheDocument();
    expect(calls[0]).toEqual([
      'metric',
      {
        metric: 'http.server.duration',
        type: 'histogram',
        aggregation: 'p95',
        service: 'api',
        groupBy: null,
        ...range,
      },
    ]);
  });

  it('markdown: renders without fetching', () => {
    const { data, calls } = fakeData();
    render(
      <PanelView
        panel={panel({ type: 'markdown', title: 'Finding', text: 'Timeouts to **payments**' })}
        range={range}
        data={data}
      />,
    );
    expect(screen.getByText('payments').tagName).toBe('STRONG');
    expect(calls).toHaveLength(0);
  });

  it('shows the error when the data source fails', async () => {
    const { data } = fakeData({ total: () => Promise.reject(new Error('query_failed: boom')) });
    render(<PanelView panel={panel({ type: 'stat', title: 'X' })} range={range} data={data} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});

describe('ViewGrid', () => {
  it('lays out half and full panels and resolves a relative range', async () => {
    const { data, calls } = fakeData();
    const spec = ViewSpec.parse({
      title: 'Checkout',
      description: 'p95 went up',
      range: { lastMinutes: 60 },
      panels: [
        { type: 'stat', title: 'A' },
        { type: 'markdown', title: 'B', text: 'x', width: 'full' },
      ],
    });
    render(<ViewGrid spec={spec} data={data} />);
    expect(screen.getByText('Checkout')).toBeInTheDocument();
    expect(screen.getByText('Last 1 hour')).toBeInTheDocument();
    expect(screen.getByTestId('panel-markdown').className).toContain('@2xl:col-span-2');
    expect(screen.getByTestId('panel-stat').className).not.toContain('col-span-2');
    await waitFor(() => expect(calls).toHaveLength(1));
    const req = calls[0]![1] as { from: string; to: string };
    expect(Date.parse(req.to) - Date.parse(req.from)).toBe(60 * 60_000);
  });
});
