import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { orderSpans, TraceWaterfall, visibleSpans } from '../src/panels/trace-waterfall';
import { span, trace } from './fixtures';

describe('orderSpans', () => {
  it('orders depth first, children by start, whatever order the rows come in', () => {
    const spans = [
      span('c2', 'root', 60, 10),
      span('g1', 'c1', 15, 5),
      span('root', '', 0, 100),
      span('c1', 'root', 10, 40),
    ];
    const ordered = orderSpans(spans);
    expect(ordered.map((o) => [o.span.spanId, o.depth])).toEqual([
      ['root', 0],
      ['c1', 1],
      ['g1', 2],
      ['c2', 1],
    ]);
    expect(ordered[0]!.childCount).toBe(2);
  });

  it('makes a span with a missing parent a root, ordered by start', () => {
    const ordered = orderSpans([span('late', 'gone', 50, 5), span('root', '', 0, 100), span('child', 'root', 5, 5)]);
    expect(ordered.map((o) => [o.span.spanId, o.depth])).toEqual([
      ['root', 0],
      ['child', 1],
      ['late', 0],
    ]);
  });

  it('survives a cycle in bad data', () => {
    const ordered = orderSpans([span('a', 'b', 0, 5), span('b', 'a', 1, 5)]);
    expect(ordered.map((o) => o.span.spanId).sort()).toEqual(['a', 'b']);
  });

  it('computes offsets from timestamps when the API sends none', () => {
    const s = span('x', '', 0, 5);
    const t = span('y', 'x', 30, 5);
    const ordered = orderSpans([{ ...t, offsetMs: undefined }, { ...s, offsetMs: undefined }]);
    expect(ordered.map((o) => o.offsetMs)).toEqual([0, 30]);
  });

  it('hides the descendants of a collapsed span', () => {
    const ordered = orderSpans([span('root', '', 0, 100), span('c1', 'root', 10, 40), span('g1', 'c1', 15, 5), span('c2', 'root', 60, 10)]);
    expect(visibleSpans(ordered, new Set(['c1'])).map((o) => o.span.spanId)).toEqual(['root', 'c1', 'c2']);
  });
});

describe('TraceWaterfall', () => {
  const t = trace([
    span('c2', 'root', 60, 10, { service: 'db', status: 'Error', statusMessage: 'deadlock' }),
    span('root', '', 0, 100),
    span('c1', 'root', 10, 40, { service: 'worker' }),
  ]);

  it('draws the rows in tree order, indented, and marks errors', () => {
    render(<TraceWaterfall trace={t} />);
    const items = screen.getAllByRole('treeitem');
    expect(items.map((i) => i.getAttribute('data-span-id'))).toEqual(['root', 'c1', 'c2']);
    expect(items.map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '2']);
    expect(items[2]!.className).toContain('bg-rddim');
    expect(screen.getByText('1 error')).toBeInTheDocument();
  });

  it('shows a span’s detail on click and folds a subtree', () => {
    render(<TraceWaterfall trace={t} />);
    fireEvent.click(screen.getAllByRole('treeitem')[2]!);
    const detail = screen.getByTestId('span-detail');
    expect(within(detail).getByText('op-c2')).toBeInTheDocument();
    expect(within(detail).getByText('deadlock')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getAllByRole('treeitem').map((i) => i.getAttribute('data-span-id'))).toEqual(['root']);
  });
});
