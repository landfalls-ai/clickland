import type { Note, NoteInput } from '@clickland/contracts';
import type { Sql } from './clients.js';
import { newId } from './ids.js';
import type { Webhooks } from './webhooks.js';

type Row = {
  id: string;
  title: string;
  body: string;
  service: string | null;
  tags: string[];
  trace_ids: string[];
  alert_event_id: string | null;
  author: string;
  created_at: Date;
  rank?: number;
};

const toNote = (r: Row): Note => ({
  id: r.id,
  title: r.title,
  body: r.body,
  service: r.service,
  tags: r.tags,
  traceIds: r.trace_ids,
  alertEventId: r.alert_event_id,
  author: r.author,
  createdAt: r.created_at.toISOString(),
});

export class Notes {
  constructor(
    private readonly pg: Sql,
    private readonly webhooks: Webhooks,
  ) {}

  async list(filter: { service?: string | null; q?: string | null; limit?: number }): Promise<Note[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const service = filter.service || null;
    const q = filter.q?.trim() || null;
    const rows = await this.pg<Row[]>`
      SELECT * FROM notes
      WHERE (${service}::text IS NULL OR service = ${service})
        AND (${q}::text IS NULL OR search @@ websearch_to_tsquery('english', ${q}))
      ORDER BY ${q ? this.pg`ts_rank_cd(search, websearch_to_tsquery('english', ${q})) DESC,` : this.pg``} created_at DESC
      LIMIT ${limit}`;
    return rows.map(toNote);
  }

  /** Full-text matches with their rank, for knowledge search. Any word may match (OR), so a question finds notes. */
  async search(question: string, limit: number): Promise<(Note & { rank: number })[]> {
    const rows = await this.pg<(Row & { rank: number })[]>`
      WITH q AS (
        SELECT to_tsquery('english', string_agg(lexeme, ' | ')) AS tsq
        FROM unnest(to_tsvector('english', ${question}))
      )
      SELECT n.*, ts_rank_cd(n.search, q.tsq, 32) AS rank
      FROM notes n, q
      WHERE q.tsq IS NOT NULL AND n.search @@ q.tsq
      ORDER BY rank DESC, n.created_at DESC
      LIMIT ${limit}`;
    return rows.map((r) => ({ ...toNote(r), rank: Number(r.rank) }));
  }

  async create(input: NoteInput, author: string): Promise<Note> {
    const [row] = await this.pg<Row[]>`
      INSERT INTO notes (id, title, body, service, tags, trace_ids, alert_event_id, author)
      VALUES (${newId('nt')}, ${input.title}, ${input.body}, ${input.service ?? null}, ${input.tags},
              ${input.traceIds.map((t) => t.toLowerCase())}, ${input.alertEventId ?? null}, ${input.author ?? author})
      RETURNING *`;
    const note = toNote(row!);
    await this.webhooks.enqueue('note.created', { note });
    return note;
  }
}
