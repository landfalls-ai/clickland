/**
 * Services for integration tests on the shared local database: events a test causes (alert firings, new notes) reach
 * only the webhooks the test made. Without this, a test alert would also go to every real catch-all subscription
 * (Landflow's triage flow).
 */
import type { WebhookEvent } from '@clickland/contracts';
import { Alerts } from '../src/alerts.js';
import type { Clients } from '../src/clients.js';
import type { Config } from '../src/config.js';
import { Knowledge } from '../src/knowledge.js';
import { Notes } from '../src/notes.js';
import { createServices, type Services } from '../src/services.js';
import { Webhooks } from '../src/webhooks.js';

export class ScopedWebhooks extends Webhooks {
  /** The only webhooks this instance queues events for. */
  readonly allowed = new Set<string>();

  protected override async subscribers(type: WebhookEvent, alertId: string | null) {
    return (await super.subscribers(type, alertId)).filter((h) => this.allowed.has(h.id));
  }
}

export function scopedServices(config: Config, clients: Clients): Services & { webhooks: ScopedWebhooks } {
  const services = createServices(config, clients);
  const webhooks = new ScopedWebhooks(clients.pg);
  const alerts = new Alerts(clients.pg, services.telemetry, webhooks, config);
  const notes = new Notes(clients.pg, webhooks);
  const knowledge = new Knowledge(services.telemetry, notes, alerts, config);
  return { ...services, webhooks, alerts, notes, knowledge };
}
