import type { WebhookEvent, WebhookInput } from '@clickland/contracts';
import { createHmac, randomBytes } from 'node:crypto';
import type { Sql } from './clients.js';
import { notFound } from './errors.js';
import { newId } from './ids.js';

/** Standard Webhooks retry schedule: the wait after each failed attempt; after the last one the delivery fails. */
export const RETRY_DELAYS_S = [5, 30, 120, 600, 1800];
const TIMEOUT_MS = 10_000;
/** A claimed delivery is hidden from other dispatchers for this long, so a crash mid-send retries it later. */
const LEASE_S = 60;

export interface WebhookView {
  id: string;
  url: string;
  events: WebhookEvent[];
  alertId: string | null;
  description: string;
  createdAt: string;
}

type Row = {
  id: string;
  url: string;
  events: WebhookEvent[];
  alert_id: string | null;
  description: string;
  created_at: Date;
};
const toView = (r: Row): WebhookView => ({
  id: r.id,
  url: r.url,
  events: r.events,
  alertId: r.alert_id,
  description: r.description,
  createdAt: r.created_at.toISOString(),
});

/** The Standard Webhooks signature: `v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<body>")>`. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export class Webhooks {
  constructor(
    private readonly pg: Sql,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async list(): Promise<WebhookView[]> {
    const rows = await this.pg<Row[]>`SELECT * FROM webhooks ORDER BY created_at DESC`;
    return rows.map(toView);
  }

  async get(id: string): Promise<WebhookView> {
    const [row] = await this.pg<Row[]>`SELECT * FROM webhooks WHERE id = ${id}`;
    if (!row) throw notFound('Webhook');
    return toView(row);
  }

  async create(input: WebhookInput): Promise<WebhookView & { secret: string }> {
    const secret = `whsec_${randomBytes(24).toString('base64')}`;
    const [row] = await this.pg<Row[]>`
      INSERT INTO webhooks (id, url, secret, events, alert_id, description)
      VALUES (${newId('wh')}, ${input.url}, ${secret}, ${input.events}, ${input.alertId ?? null}, ${input.description})
      RETURNING *`;
    return { ...toView(row!), secret };
  }

  async delete(id: string): Promise<void> {
    const rows = await this.pg`DELETE FROM webhooks WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw notFound('Webhook');
  }

  /** Queues one event for every subscription that wants it; the dispatcher sends them. Returns the event id. */
  async enqueue(
    type: WebhookEvent,
    data: unknown,
    alertId: string | null = null,
  ): Promise<{ eventId: string; deliveries: number }> {
    const eventId = newId('evt');
    const payload = { type, id: eventId, timestamp: new Date().toISOString(), data };
    const rows = await this.pg`
      INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status)
      SELECT 'whd_' || substr(md5(random()::text || w.id), 1, 20), w.id, ${eventId}, ${type}, ${this.pg.json(payload as never)}, 'pending'
      FROM webhooks w
      WHERE ${type} = ANY (w.events) AND (w.alert_id IS NULL OR w.alert_id = ${alertId})
      RETURNING id`;
    return { eventId, deliveries: rows.length };
  }

  /** Sends the deliveries that are due. Safe to run in several processes: each claims rows with a lease. */
  async dispatchDue(limit = 20): Promise<number> {
    const due = await this.pg<
      { id: string; event_id: string; payload: unknown; attempts: number; url: string; secret: string }[]
    >`
      UPDATE webhook_deliveries d SET next_attempt_at = now() + make_interval(secs => ${LEASE_S})
      FROM webhooks w
      WHERE d.id IN (
        SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) AND w.id = d.webhook_id
      RETURNING d.id, d.event_id, d.payload, d.attempts, w.url, w.secret`;
    await Promise.all(due.map((d) => this.send(d)));
    return due.length;
  }

  private async send(d: {
    id: string;
    event_id: string;
    payload: unknown;
    attempts: number;
    url: string;
    secret: string;
  }) {
    const body = JSON.stringify(d.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    let error: string | null = null;
    try {
      const res = await this.fetchImpl(d.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Clickland-Webhooks/0.1',
          'webhook-id': d.event_id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signWebhook(d.secret, d.event_id, timestamp, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const attempts = d.attempts + 1;
    if (error === null) {
      await this
        .pg`UPDATE webhook_deliveries SET status = 'delivered', attempts = ${attempts}, delivered_at = now(), last_error = null WHERE id = ${d.id}`;
    } else if (attempts > RETRY_DELAYS_S.length) {
      await this
        .pg`UPDATE webhook_deliveries SET status = 'failed', attempts = ${attempts}, last_error = ${error.slice(0, 500)} WHERE id = ${d.id}`;
    } else {
      const wait = RETRY_DELAYS_S[attempts - 1]!;
      await this.pg`
        UPDATE webhook_deliveries
        SET attempts = ${attempts}, last_error = ${error.slice(0, 500)}, next_attempt_at = now() + make_interval(secs => ${wait})
        WHERE id = ${d.id}`;
    }
  }

  async deliveries(webhookId: string, limit = 50) {
    await this.get(webhookId);
    const rows = await this.pg<
      {
        id: string;
        event_id: string;
        event_type: string;
        status: string;
        attempts: number;
        last_error: string | null;
        created_at: Date;
        delivered_at: Date | null;
      }[]
    >`
      SELECT id, event_id, event_type, status, attempts, last_error, created_at, delivered_at
      FROM webhook_deliveries WHERE webhook_id = ${webhookId} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      type: r.event_type,
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error,
      createdAt: r.created_at.toISOString(),
      deliveredAt: r.delivered_at?.toISOString() ?? null,
    }));
  }
}
