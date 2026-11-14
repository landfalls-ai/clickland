import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, parseBlocks, safeHref } from '../src/panels/markdown';
import { templateParts } from '../src/panels/patterns-list';
import { formatCount, formatDuration, formatPercent } from '../src/format';

describe('Markdown', () => {
  it('parses headings, lists, code, quotes and tables', () => {
    const blocks = parseBlocks('# Title\n\nSome *text*\n\n- a\n- b\n  - nested\n\n```sql\nSELECT 1\n```\n\n> quoted\n\n| a | b |\n|---|--:|\n| 1 | 2 |');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'code', 'quote', 'table']);
    const list = blocks[2] as Extract<(typeof blocks)[number], { type: 'list' }>;
    expect(list.items).toHaveLength(2);
    expect(list.items[1]!.map((b) => b.type)).toEqual(['paragraph', 'list']);
  });

  it('never renders raw HTML or unsafe links', () => {
    const { container } = render(<Markdown text={'<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://example.com)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://example.com');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('//evil.com')).toBeNull();
    expect(safeHref('/search?q=1')).toBe('/search?q=1');
  });

  it('renders inline styles', () => {
    render(<Markdown text={'**bold** _it_ `code` ~~gone~~ https://x.test/a.'} />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('it').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByText('gone').tagName).toBe('DEL');
    expect(screen.getByText('https://x.test/a').tagName).toBe('A');
  });
});

describe('formatting', () => {
  it('formats counts, durations and percentages', () => {
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(12_345)).toBe('12.3k');
    expect(formatCount(2_500_000)).toBe('2.5M');
    expect(formatDuration(0.25)).toBe('250 µs');
    expect(formatDuration(12.34)).toBe('12.3 ms');
    expect(formatDuration(1240)).toBe('1.24 s');
    expect(formatDuration(123_000)).toBe('2 m 03 s');
    expect(formatPercent(0.0123)).toBe('1.2%');
    expect(formatPercent(0.0001)).toBe('<0.1%');
  });

  it('splits pattern templates', () => {
    expect(templateParts('a <*> b <NUM>')).toEqual([
      { text: 'a ', placeholder: false },
      { text: '<*>', placeholder: true },
      { text: ' b ', placeholder: false },
      { text: '<NUM>', placeholder: true },
    ]);
  });
});
