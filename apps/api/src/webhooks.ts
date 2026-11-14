import type {
  IncidentLink,
  SourceTriggerPayload,
  TriggerResult,
  WebhookEvent,
  WebhookFormat,
  WebhookInput,
} from '@clickland/contracts';
import { createHmac, randomBytes } from 'node:crypto';
import type { Sql } from './clients.js';
import { notFound } from './errors.js';
import { newId } from './ids.js';
import { incidentLink, type Route } from './landfall.js';

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
  format: WebhookFormat;
  /** For `landfall`: the connection (the ingest token is never returned). */
  landfall: { connectionId: string } | null;
  createdAt: string;
}

type Row = {
  id: string;
  url: string;
  events: WebhookEvent[];
  alert_id: string | null;
  description: string;
  format: WebhookFormat;
  connection_id: string | null;
  created_at: Date;
};
const toView = (r: Row): WebhookView => ({
  id: r.id,
  url: r.url,
  events: r.events,
  alertId: r.alert_id,
  description: r.description,
  format: r.format,
  landfall: r.format === 'landfall' && r.connection_id ? { connectionId: r.connection_id } : null,
  createdAt: r.created_at.toISOString(),
});

/** An alert event's delivery facts: its route, and the Landfall body for a `landfall` webhook's connection. */
export interface AlertDelivery {
  alertEventId: string;
  route: Route;
  trigger: (connectionId: string) => SourceTriggerPayload;
}

type Due = {
  id: string;
  event_id: string;
  payload: unknown;
  attempts: number;
  alert_event_id: string | null;
  url: string;
  secret: string;
  format: WebhookFormat;
  auth_token: string | null;
};

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
    const landfall = input.format === 'landfall' ? input.landfall : null;
    const [row] = await this.pg<Row[]>`
      INSERT INTO webhooks (id, url, secret, events, alert_id, description, format, auth_token, connection_id)
      VALUES (${newId('wh')}, ${input.url}, ${secret}, ${input.events}, ${input.alertId ?? null}, ${input.description},
              ${input.format}, ${landfall?.ingestToken ?? null}, ${landfall?.connectionId ?? null})
      RETURNING *`;
    return { ...toView(row!), secret };
  }

  async delete(id: string): Promise<void> {
    const rows = await this.pg`DELETE FROM webhooks WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw notFound('Webhook');
  }

  /** The subscriptions that want an event: its type, and every alert or this one. */
  protected async subscribers(
    type: WebhookEvent,
    alertId: string | null,
  ): Promise<{ id: string; format: WebhookFormat; connection_id: string | null }[]> {
    return await this.pg<{ id: string; format: WebhookFormat; connection_id: string | null }[]>`
      SELECT id, format, connection_id FROM webhooks
      WHERE ${type} = ANY (events) AND (alert_id IS NULL OR alert_id = ${alertId})`;
  }

  /**
   * Queues one event for every subscription that wants it; the dispatcher sends them. Returns the event id.
   * A `standard` webhook gets Clickland's payload. A `landfall` webhook gets Landfall's trigger body, and only for an
   * alert event on the direct route.
   */
  async enqueue(
    type: WebhookEvent,
    data: unknown,
    alertId: string | null = null,
    alert?: AlertDelivery,
  ): Promise<{ eventId: string; deliveries: number }> {
    const eventId = newId('evt');
    const payload = { type, id: eventId, timestamp: new Date().toISOString(), data };
    const hooks = await this.subscribers(type, alertId);
    let deliveries = 0;
    for (const hook of hooks) {
      let body: unknown = payload;
      if (hook.format === 'landfall') {
        if (alert?.route !== 'direct' || !hook.connection_id) continue;
        body = alert.trigger(hook.connection_id);
      }
      await this.pg`
        INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, alert_event_id)
        VALUES (${newId('whd')}, ${hook.id}, ${eventId}, ${type}, ${this.pg.json(body as never)}, 'pending',
                ${alert?.alertEventId ?? null})`;
      deliveries++;
    }
    return { eventId, deliveries };
  }

  /** Sends the deliveries that are due. Safe to run in several processes: each claims rows with a lease. */
  async dispatchDue(limit = 20, onlyWebhooks: string[] | null = null): Promise<number> {
    const due = await this.pg<Due[]>`
      UPDATE webhook_deliveries d SET next_attempt_at = now() + make_interval(secs => ${LEASE_S})
      FROM webhooks w
      WHERE d.id IN (
        SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= now()
          AND (${onlyWebhooks}::text[] IS NULL OR webhook_id = ANY (${onlyWebhooks}::text[]))
        ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) AND w.id = d.webhook_id
      RETURNING d.id, d.event_id, d.payload, d.attempts, d.alert_event_id, w.url, w.secret, w.format, w.auth_token`;
    await Promise.all(due.map((d) => this.send(d)));
    return due.length;
  }

  private async send(d: Due) {
    const body = JSON.stringify(d.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const landfall = d.format === 'landfall';
    let error: string | null = null;
    let answer: unknown = null;
    try {
      const res = await this.fetchImpl(d.url, {
        method: 'POST',
        headers: landfall
          ? {
              'content-type': 'application/json',
              'user-agent': 'Clickland-Webhooks/0.1',
              authorization: `Bearer ${d.auth_token ?? ''}`,
            }
          : {
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
      const ok = res.status >= 200 && res.status < 300;
      if (landfall) {
        // Landfall answers with a TriggerResult (or, on a refusal, says why).
        const text = await res.text().catch(() => '');
        if (ok) answer = safeJson(text);
        else error = `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`;
      } else {
        if (!ok) error = `HTTP ${res.status}`;
        await res.body?.cancel().catch(() => {});
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const attempts = d.attempts + 1;
    if (error === null) {
      await this
        .pg`UPDATE webhook_deliveries SET status = 'delivered', attempts = ${attempts}, delivered_at = now(), last_error = null WHERE id = ${d.id}`;
      if (landfall && d.alert_event_id) await this.recordIncident(d.alert_event_id, answer);
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

  /**
   * Keeps Landfall's answer on the alert event, and on the group's state when it names a room, so the next firing of
   * the group shows the room it attaches to.
   */
  async recordIncident(alertEventId: string, answer: unknown): Promise<IncidentLink | null> {
    const result = answer as Partial<TriggerResult> | null;
    if (!result || typeof result.outcome !== 'string') return null;
    const [event] = await this.pg<{ alert_id: string; group_key: string; incident: IncidentLink | null }[]>`
      SELECT alert_id, group_key, incident FROM alert_events WHERE id = ${alertEventId}`;
    if (!event) return null;
    const link = incidentLink(result, event.incident);
    await this.pg`UPDATE alert_events SET incident = ${this.pg.json(link as never)} WHERE id = ${alertEventId}`;
    if (link.id)
      await this.pg`
        UPDATE alert_states SET incident = ${this.pg.json(link as never)}
        WHERE alert_id = ${event.alert_id} AND group_key = ${event.group_key}`;
    return link;
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
