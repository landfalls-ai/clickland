/**
 * Alerts to Landfall over its generic remote trigger (`SourceTriggerPayload` to `POST /triggers`). Only alerts on the
 * direct route go this way (sev1, or `direct: true` for alerts about Landflow itself); the rest reach Landfall through
 * Landflow's triage. A resolve sends Landfall's recovery, which records `trigger.recovered` on the room: it never closes
 * a room, because only a person ends one (docs/research/land-family-integrations.md §2.2, §5).
 */
import {
  type IncidentLink,
  type LogRow,
  type Severity,
  SourceTriggerPayload,
  type SpanRow,
  type TriggerResult,
} from '@clickland/contracts';

export type Route = 'direct' | 'triage';

/** sev1 always goes straight to Landfall; so does an alert marked `direct`. Everything else goes through triage. */
export const routeOf = (alert: { severity: Severity; direct: boolean }): Route =>
  alert.severity === 'sev1' || alert.direct ? 'direct' : 'triage';

/** What the mapping reads: the webhook's `data` for one alert event. */
export interface AlertNotice {
  alert: {
    id: string;
    name: string;
    signal: 'logs' | 'traces';
    query: string;
    groupBy: string | null;
    thresholdType: 'above' | 'below';
    threshold: number;
    windowMinutes: number;
    severity: Severity;
    labels: Record<string, string>;
    runbookUrl: string | null;
  };
  status: 'firing' | 'ok';
  groupKey: string;
  value: number;
  fingerprint: string;
  occurredAt: string;
  url: string;
  searchUrl: string;
  samples: (LogRow | SpanRow)[];
}

const SERVICE_FIELDS = new Set(['service', 'ServiceName', 'service.name', 'resource.service.name']);

/** `service:x` from a search's `service:` term (`service:core-api`, `service:"core-api"`), if it has one. */
export function serviceInQuery(query: string): string | undefined {
  const m = query.match(/(?:^|[\s(])(?:service|ServiceName|service\.name):(?:"([^"]+)"|([^\s()"*]+))/);
  return m?.[1] ?? m?.[2];
}

/**
 * Landfall's entity hints, `key:value`: the service (from the group when grouped by service, else the query's
 * `service:` term, else a sample), the group when grouped by something else, then the alert's labels.
 */
export function entityHints(n: AlertNotice): string[] {
  const hints: string[] = [];
  const grouped = n.alert.groupBy && n.groupKey;
  const service =
    (grouped && SERVICE_FIELDS.has(n.alert.groupBy!) ? n.groupKey : undefined) ??
    serviceInQuery(n.alert.query) ??
    n.samples.find((s) => s.service)?.service;
  if (service) hints.push(`service:${service}`);
  if (grouped && !SERVICE_FIELDS.has(n.alert.groupBy!)) hints.push(`${n.alert.groupBy}:${n.groupKey}`);
  for (const [k, v] of Object.entries(n.alert.labels)) if (!hints.includes(`${k}:${v}`)) hints.push(`${k}:${v}`);
  return hints;
}

/** The body Clickland posts to Landfall's `POST /triggers` for one alert event. */
export function toTriggerPayload(n: AlertNotice, connectionId: string): SourceTriggerPayload {
  const rows = n.alert.signal === 'logs' ? 'log rows' : 'spans';
  const rule = `alert when ${n.alert.thresholdType} ${n.alert.threshold} in ${n.alert.windowMinutes} min`;
  const firing = n.status === 'firing';
  const summary = [
    firing
      ? `${n.value} matching ${rows} in the last ${n.alert.windowMinutes} min (${rule}).`
      : `Recovered: ${n.value} matching ${rows} in the last ${n.alert.windowMinutes} min (${rule}).`,
    n.alert.query ? `Search: ${n.alert.query}` : '',
    `Open in Clickland: ${n.searchUrl}`,
    n.alert.runbookUrl ? `Runbook: ${n.alert.runbookUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const hints = entityHints(n);
  const body = {
    landfallSource: 'remote' as const,
    connectionId,
    title: `${n.alert.name}${n.groupKey ? ` (${n.groupKey})` : ''}`,
    severity: n.alert.severity,
    occurredAt: n.occurredAt,
    ...(hints.length ? { entityHints: hints } : {}),
    dedupKey: n.fingerprint,
    summary,
    url: n.url,
    kind: firing ? ('trigger' as const) : ('recovery' as const),
  };
  // A console URL Landfall would refuse (not absolute) is dropped rather than failing the delivery.
  const parsed = SourceTriggerPayload.safeParse(body);
  if (parsed.success) return parsed.data;
  const { url: _url, ...rest } = body;
  return SourceTriggerPayload.parse(rest);
}

/** Landfall's answer as the link Clickland keeps. A replay that names no room keeps the room it already had. */
export function incidentLink(
  result: Partial<TriggerResult>,
  previous: IncidentLink | null,
  at = new Date(),
): IncidentLink {
  const outcome = result.outcome ?? 'ignored';
  const id = result.incidentId || null;
  return {
    system: 'landfall',
    id: id ?? previous?.id ?? null,
    url: id ? result.workspaceUrl || null : (previous?.url ?? null),
    outcome,
    at: at.toISOString(),
  };
}
