import { Agents } from './agents.js';
import { Alerts } from './alerts.js';
import type { Clients } from './clients.js';
import type { Config } from './config.js';
import { Keys } from './keys.js';
import { Knowledge } from './knowledge.js';
import { Notes } from './notes.js';
import { Telemetry } from './telemetry.js';
import { ValueStore } from './value.js';
import { Views } from './views.js';
import { Webhooks } from './webhooks.js';

/** Everything the routes and the MCP server call. */
export interface Services {
  config: Config;
  clients: Clients;
  telemetry: Telemetry;
  webhooks: Webhooks;
  alerts: Alerts;
  notes: Notes;
  views: Views;
  knowledge: Knowledge;
  keys: Keys;
  /** AI agents and their value (docs/agent-value.md). */
  agents: Agents;
  value: ValueStore;
}

export function createServices(config: Config, clients: Clients, fetchImpl: typeof fetch = fetch): Services {
  const telemetry = new Telemetry(clients.ch);
  const webhooks = new Webhooks(clients.pg, fetchImpl);
  const alerts = new Alerts(clients.pg, telemetry, webhooks, config);
  const notes = new Notes(clients.pg, webhooks);
  const views = new Views(clients.pg, config);
  const knowledge = new Knowledge(telemetry, notes, alerts, config);
  const keys = new Keys(clients.pg);
  const value = new ValueStore(clients.pg);
  const agents = new Agents(clients.ch, value);
  return { config, clients, telemetry, webhooks, alerts, notes, views, knowledge, keys, agents, value };
}

/** The alert evaluator and the webhook dispatcher: small loops that claim due rows, so replicas can share the work. */
export function startBackgroundJobs(services: Services, log: (msg: string, err?: unknown) => void): () => void {
  let stopped = false;
  const loop = (name: string, everyMs: number, run: () => Promise<number>) => {
    let timer: NodeJS.Timeout;
    const tick = async () => {
      if (stopped) return;
      try {
        // Keep going while there is a backlog; otherwise wait.
        const n = await run();
        timer = setTimeout(tick, n > 0 ? 50 : everyMs);
      } catch (error) {
        log(`${name} failed`, error);
        timer = setTimeout(tick, everyMs * 4);
      }
    };
    timer = setTimeout(tick, everyMs);
    return () => clearTimeout(timer);
  };
  const stops = [
    loop('alert evaluator', 10_000, () => services.alerts.evaluateDue()),
    loop('webhook dispatcher', 2_000, () => services.webhooks.dispatchDue()),
  ];
  return () => {
    stopped = true;
    for (const stop of stops) stop();
  };
}
