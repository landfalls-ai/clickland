import type { KnowledgeResult } from '@clickland/contracts';
import type { Alerts } from './alerts.js';
import type { Config } from './config.js';
import type { Notes } from './notes.js';
import { resolveRange, type Telemetry } from './telemetry.js';

const STOPWORDS = new Set(
  `a about after all also an and any are as at be because been before being but by can could did do does doing down during
  each few for from further had has have having how i if in into is it its just me more most my no nor not now of off on
  once only or other our out over own same should so some such than that the their them then there these they this those
  through to too under until up very was we were what when where which while who whom why will with would you your
  happen happened happening going wrong issue issues problem problems see show tell look find why's what's whats`.split(
    /\s+/,
  ),
);

/** The question's content words: lowercase letters and digits (what the text index tokenizes on), no stopwords. */
export function questionWords(question: string): string[] {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 12);
}

const ERROR_WORDS = new Set([
  'error',
  'errors',
  'fail',
  'failed',
  'failing',
  'failure',
  'exception',
  'crash',
  'timeout',
  'timeouts',
  'slow',
  'latency',
  'down',
  'outage',
  '500',
  '502',
  '503',
  '504',
]);

/**
 * Knowledge search for agents: what Clickland knows that answers a question. It looks in four places and ranks them
 * on one 0–1 scale: notes (full text), alert events in the range whose alert shares a word with the question,
 * services the question names (with their numbers), and log patterns among the rows matching the question's words.
 */
export class Knowledge {
  constructor(
    private readonly telemetry: Telemetry,
    private readonly notes: Notes,
    private readonly alerts: Alerts,
    private readonly config: Config,
  ) {}

  async search(input: {
    query: string;
    from?: string | null;
    to?: string | null;
    limit: number;
  }): Promise<{ results: KnowledgeResult[] }> {
    const range = resolveRange(input, 24 * 60);
    const words = questionWords(input.query);
    const settle = <T>(p: Promise<T>, fallback: T) =>
      p.catch((e: unknown) => (console.warn('knowledge:', e instanceof Error ? e.message : e), fallback));

    const [notes, events, services] = await Promise.all([
      settle(this.notes.search(input.query, input.limit), []),
      settle(this.alerts.recentEvents(range.from, 100), []),
      settle(this.telemetry.services({ from: range.from.toISOString(), to: range.to.toISOString() }), { services: [] }),
    ]);
    const results: KnowledgeResult[] = [];

    const maxRank = Math.max(...notes.map((n) => n.rank), 0.0001);
    for (const n of notes) {
      results.push({
        pageContent: `Note: ${n.title}\n${n.service ? `Service: ${n.service}\n` : ''}${n.tags.length ? `Tags: ${n.tags.join(', ')}\n` : ''}${n.links.length ? `Links: ${n.links.map((l) => `${l.label} <${l.url}>`).join(', ')}\n` : ''}By ${n.author} on ${n.createdAt}\n\n${n.body}`,
        score: 0.55 + 0.4 * (n.rank / maxRank),
        metadata: {
          kind: 'note',
          title: n.title,
          service: n.service ?? undefined,
          id: n.id,
          url: `${this.config.consoleUrl}/notes/${n.id}`,
          ...(n.links.length ? { links: n.links } : {}),
        },
      });
    }

    const wordSet = new Set(words);
    const shares = (text: string) =>
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => wordSet.has(w)).length;
    const seenAlert = new Set<string>();
    for (const e of events) {
      const overlap = shares(`${e.alertName} ${e.query} ${e.groupKey}`);
      const key = `${e.alertId}:${e.groupKey}`;
      if ((overlap === 0 && words.length > 0) || seenAlert.has(key)) continue;
      seenAlert.add(key);
      results.push({
        pageContent: `Alert "${e.alertName}"${e.groupKey ? ` (${e.groupKey})` : ''} was ${e.state === 'firing' ? 'FIRING' : 'resolved'} at ${e.createdAt}: ${e.value} matching ${e.signal} in the window ${e.windowStart} – ${e.windowEnd} (threshold ${e.threshold}). Search: ${e.query || '(everything)'}`,
        score: Math.min(0.9, 0.6 + 0.1 * overlap + (e.state === 'firing' ? 0.05 : 0)),
        metadata: {
          kind: 'alert',
          title: e.alertName,
          id: e.alertId,
          url: `${this.config.consoleUrl}/alerts/${e.alertId}`,
          service: e.groupKey || undefined,
        },
      });
    }

    const named = services.services.filter((s) => {
      const name = s.name.toLowerCase();
      return name && (wordSet.has(name) || input.query.toLowerCase().includes(name));
    });
    const errorish = words.some((w) => ERROR_WORDS.has(w));
    const listed = named.length
      ? named
      : errorish
        ? services.services.filter((s) => s.errors + s.logErrors > 0).slice(0, 3)
        : [];
    for (const s of listed) {
      results.push({
        pageContent: `Service ${s.name} (${range.from.toISOString()} – ${range.to.toISOString()}): ${s.requests} requests, ${s.errors} error spans (${(s.errorRate * 100).toFixed(2)}%), latency p50 ${s.p50Ms} ms, p95 ${s.p95Ms} ms, p99 ${s.p99Ms} ms, ${s.logErrors} error logs.`,
        score: named.length ? 0.9 : 0.6,
        metadata: {
          kind: 'service',
          title: s.name,
          service: s.name,
          url: `${this.config.consoleUrl}/services/${encodeURIComponent(s.name)}`,
        },
      });
    }

    // Patterns among the log rows that match the question: the named services, and any of the other words.
    const serviceNames = new Set(named.map((s) => s.name.toLowerCase()));
    const other = words.filter((w) => !serviceNames.has(w) && !ERROR_WORDS.has(w));
    const clauses = [
      named.length ? `(${named.map((s) => `service:"${s.name.replace(/"/g, '\\"')}"`).join(' OR ')})` : '',
      other.length ? `(${other.join(' OR ')})` : '',
      errorish ? '(level:error OR level:fatal OR level:critical OR level:ERROR OR level:FATAL)' : '',
    ].filter(Boolean);
    if (clauses.length) {
      const query = clauses.join(' ');
      const patterns = await settle(
        this.telemetry.patterns({
          signal: 'logs',
          query,
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          sample: 2000,
        }),
        { patterns: [], sampled: 0, total: 0 },
      );
      for (const p of patterns.patterns.slice(0, 5)) {
        results.push({
          pageContent: `Log pattern (${p.count} of ${patterns.sampled} sampled rows, ${patterns.total} matching in total; services ${p.services.join(', ') || '-'}): ${p.template}\nExample: ${p.example}`,
          score: 0.35 + 0.4 * p.share,
          metadata: {
            kind: 'pattern',
            title: p.template.slice(0, 120),
            service: p.services[0],
            url: `${this.config.consoleUrl}/search?${new URLSearchParams({ signal: 'logs', query, from: range.from.toISOString(), to: range.to.toISOString() })}`,
          },
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return { results: results.slice(0, input.limit).map((r) => ({ ...r, score: Math.round(r.score * 1000) / 1000 })) };
  }
}
