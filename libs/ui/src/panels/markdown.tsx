import { Fragment, type ReactNode } from 'react';
import { cn } from '../cn';

/**
 * A small, safe Markdown renderer: it builds React elements and never sets HTML, so text from an agent or a note
 * can't inject markup. It covers what chat answers and notes use: headings, paragraphs, lists (nested by indent),
 * block quotes, fenced code, tables, rules, and inline code, bold, italic, strikethrough and links.
 */

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'table'; head: string[]; align: ('left' | 'center' | 'right' | null)[]; rows: string[][] }
  | { type: 'rule' };

const isFence = (line: string) => /^\s*(```|~~~)/.test(line);
const listMarker = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (line: string, next?: string) =>
    /^\s{0,3}#{1,6}\s/.test(line) ||
    isFence(line) ||
    /^\s{0,3}>/.test(line) ||
    listMarker.test(line) ||
    /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) ||
    (line.includes('|') && next !== undefined && isTableSep(next));

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (isFence(line)) {
      const fence = line.trim().slice(0, 3);
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence)) body.push(lines[i++]!);
      i++;
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''));
      blocks.push({ type: 'quote', blocks: parseBlocks(body.join('\n')) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(splitRow(lines[i++]!));
      blocks.push({ type: 'table', head, align, rows });
      continue;
    }
    const marker = listMarker.exec(line);
    if (marker) {
      const indent = marker[1]!.length;
      const ordered = /\d/.test(marker[2]!);
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = listMarker.exec(l);
        if (m && m[1]!.length <= indent && /\d/.test(m[2]!) === ordered) {
          items.push([m[3]!]);
          i++;
        } else if (l.trim() && (/^\s/.test(l) || !startsBlock(l, lines[i + 1])) && items.length) {
          // A continuation or a nested list: keep it in the item, dedented.
          items[items.length - 1]!.push(l.replace(new RegExp(`^\\s{0,${indent + 4}}`), ''));
          i++;
        } else if (!l.trim() && i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && items.length) {
          items[items.length - 1]!.push('');
          i++;
        } else break;
      }
      blocks.push({
        type: 'list',
        ordered,
        start: ordered ? parseInt(marker[2]!, 10) : 1,
        items: items.map((item) => parseBlocks(item.join('\n'))),
      });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !(para.length && startsBlock(lines[i]!, lines[i + 1]))) {
      para.push(lines[i++]!.trim());
    }
    blocks.push({ type: 'paragraph', text: para.join('\n') });
  }
  return blocks;
}

/** Only these link targets render as links; anything else (javascript:, data:, …) stays text. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^(https?:|mailto:)/i.test(h)) return h;
  if (/^\/(?!\/)/.test(h) || h.startsWith('#')) return h;
  return null;
}

type LinkRenderer = (href: string, children: ReactNode) => ReactNode;

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^\s*][\s\S]*?)\*|(?<![\w])_([^\s_][\s\S]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\n/g;

export function renderInline(text: string, link: LinkRenderer, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}${n++}`;
    if (m[1])
      out.push(
        <code key={key} className="rounded bg-nudim px-1 py-px font-mono text-[0.92em]">
          {m[2]}
        </code>,
      );
    else if (m[3] ?? m[4])
      out.push(
        <strong key={key} className="font-semibold">
          {renderInline((m[3] ?? m[4])!, link, `${key}.`)}
        </strong>,
      );
    else if (m[5]) out.push(<del key={key}>{renderInline(m[5], link, `${key}.`)}</del>);
    else if (m[6] ?? m[7]) out.push(<em key={key}>{renderInline((m[6] ?? m[7])!, link, `${key}.`)}</em>);
    else if (m[8]) {
      const href = safeHref(m[9]!);
      const children = renderInline(m[8], link, `${key}.`);
      out.push(<Fragment key={key}>{href ? link(href, children) : children}</Fragment>);
    } else if (m[10]) out.push(<Fragment key={key}>{link(m[10], m[10])}</Fragment>);
    else out.push(<br key={key} />);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const defaultLink: LinkRenderer = (href, children) => (
  <a
    href={href}
    className="text-ac underline decoration-acbd underline-offset-2 hover:decoration-ac"
    {...(/^https?:/i.test(href) ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
  >
    {children}
  </a>
);

function renderBlocks(blocks: Block[], link: LinkRenderer, prefix = ''): ReactNode[] {
  return blocks.map((block, i) => {
    const key = `${prefix}${i}`;
    switch (block.type) {
      case 'heading': {
        const size = ['text-[17px]', 'text-[15px]', 'text-[14px]', 'text-[13px]', 'text-[13px]', 'text-[12px]'][
          block.level - 1
        ];
        const Tag = `h${block.level}` as 'h1';
        return (
          <Tag key={key} className={cn('mt-3 font-semibold text-t1 first:mt-0', size)}>
            {renderInline(block.text, link)}
          </Tag>
        );
      }
      case 'paragraph':
        return (
          <p key={key} className="my-2 first:mt-0 last:mb-0">
            {renderInline(block.text, link)}
          </p>
        );
      case 'code':
        return (
          <pre
            key={key}
            className="my-2 overflow-x-auto rounded-lg border border-hair bg-sf2 p-2.5 font-mono text-[12px] leading-relaxed"
          >
            <code data-lang={block.lang || undefined}>{block.text}</code>
          </pre>
        );
      case 'quote':
        return (
          <blockquote key={key} className="my-2 border-l-2 border-bd pl-3 text-t2">
            {renderBlocks(block.blocks, link, `${key}.`)}
          </blockquote>
        );
      case 'rule':
        return <hr key={key} className="my-3 border-hair" />;
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul';
        return (
          <Tag
            key={key}
            start={block.ordered && block.start !== 1 ? block.start : undefined}
            className={cn('my-2 flex flex-col gap-0.5 pl-5', block.ordered ? 'list-decimal' : 'list-disc')}
          >
            {block.items.map((item, j) => (
              <li key={j} className="[&>p]:my-0">
                {renderBlocks(item, link, `${key}.${j}.`)}
              </li>
            ))}
          </Tag>
        );
      }
      case 'table':
        return (
          <div key={key} className="my-2 overflow-x-auto rounded-lg border border-hair">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-hair bg-sf2">
                  {block.head.map((h, j) => (
                    <th
                      key={j}
                      className="px-2.5 py-1.5 text-left font-semibold"
                      style={{ textAlign: block.align[j] ?? undefined }}
                    >
                      {renderInline(h, link)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r} className="border-b border-hair last:border-0">
                    {block.head.map((_, j) => (
                      <td
                        key={j}
                        className="px-2.5 py-1.5 align-top"
                        style={{ textAlign: block.align[j] ?? undefined }}
                      >
                        {renderInline(row[j] ?? '', link)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function Markdown({
  text,
  className,
  renderLink = defaultLink,
}: {
  text: string;
  className?: string;
  /** Renders a (safe) link: the console sends relative links through its router. */
  renderLink?: LinkRenderer;
}) {
  return (
    <div className={cn('min-w-0 break-words text-[13px] leading-relaxed text-t1', className)} data-testid="markdown">
      {renderBlocks(parseBlocks(text), renderLink)}
    </div>
  );
}
