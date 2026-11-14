/** Alerts to Landfall: the route, the trigger body (checked against Landfall's OpenAPI file) and the room link. */
import { WebhookInput } from '@clickland/contracts';
import { describe, expect, it } from 'vitest';
import {
  type AlertNotice,
  entityHints,
  incidentLink,
  routeOf,
  serviceInQuery,
  toTriggerPayload,
} from '../src/landfall.js';
import { haveOpenApi, validateAgainst } from './landfall-openapi.js';

const notice = (over: Partial<AlertNotice> = {}, alert: Partial<AlertNotice['alert']> = {}): AlertNotice => ({
  alert: {
    id: 'al_1',
    name: 'Landfall errors',
    signal: 'logs',
    query: 'service:core-api level:error',
    groupBy: null,
    thresholdType: 'above',
    threshold: 10,
    windowMinutes: 5,
    severity: 'sev2',
    labels: {},
    runbookUrl: null,
    ...alert,
  },
  status: 'firing',
  groupKey: '',
  value: 42,
  fingerprint: 'al_1:',
  occurredAt: '2026-11-14T15:03:00.000Z',
  url: 'http://127.0.0.1:4711/alerts/al_1',
  searchUrl: 'http://127.0.0.1:4711/search?signal=logs&query=service%3Acore-api',
  samples: [],
  ...over,
});

describe('the route', () => {
  it('is direct for sev1 and for alerts marked direct, triage otherwise', () => {
    expect(routeOf({ severity: 'sev1', direct: false })).toBe('direct');
    expect(routeOf({ severity: 'sev3', direct: true })).toBe('direct');
    expect(routeOf({ severity: 'sev2', direct: false })).toBe('triage');
  });
});

describe('entity hints', () => {
  it("finds the service in the search's service: term", () => {
    expect(serviceInQuery('service:core-api level:error')).toBe('core-api');
    expect(serviceInQuery('level:error AND (service:"landflow-host")')).toBe('landflow-host');
    expect(serviceInQuery('level:error')).toBeUndefined();
  });

  it('take the group when grouped by service, else the query, else a sample; then the group and the labels', () => {
    expect(entityHints(notice({ groupKey: 'checkout' }, { groupBy: 'service', query: 'level:error' }))).toEqual([
      'service:checkout',
    ]);
    expect(entityHints(notice({}, { labels: { team: 'core' } }))).toEqual(['service:core-api', 'team:core']);
    expect(
      entityHints(
        notice(
          { groupKey: '/o/:slug', samples: [{ service: 'core-api' } as never] },
          { query: 'level:error', groupBy: 'http.route' },
        ),
      ),
    ).toEqual(['service:core-api', 'http.route:/o/:slug']);
    expect(entityHints(notice({}, { query: 'timeout' }))).toEqual([]);
  });
});

describe('the trigger body', () => {
  it('maps a firing to a trigger: dedup key, severity, hints, summary with the search and the runbook', () => {
    const body = toTriggerPayload(
      notice({}, { runbookUrl: 'https://runbooks.example/landfall-errors', labels: { team: 'core' } }),
      'conn_1',
    );
    expect(body).toEqual({
      landfallSource: 'remote',
      connectionId: 'conn_1',
      title: 'Landfall errors',
      severity: 'sev2',
      occurredAt: '2026-11-14T15:03:00.000Z',
      entityHints: ['service:core-api', 'team:core'],
      dedupKey: 'al_1:',
      summary: expect.stringContaining('42 matching log rows in the last 5 min (alert when above 10 in 5 min).'),
      url: 'http://127.0.0.1:4711/alerts/al_1',
      kind: 'trigger',
    });
    expect(body.summary).toContain('Runbook: https://runbooks.example/landfall-errors');
    expect(body.summary).toContain('Open in Clickland: http://127.0.0.1:4711/search?');
    if (haveOpenApi) expect(validateAgainst('SourceTriggerPayload', body)).toEqual([]);
  });

  it('maps a resolve to a recovery with the same dedup key (Landfall records it; it never closes the room)', () => {
    const body = toTriggerPayload(notice({ status: 'ok', value: 0, groupKey: 'web', fingerprint: 'al_1:web' }), 'c');
    expect(body).toMatchObject({ kind: 'recovery', dedupKey: 'al_1:web', title: 'Landfall errors (web)' });
    expect(body.summary).toMatch(/^Recovered: 0 matching/);
    if (haveOpenApi) expect(validateAgainst('SourceTriggerPayload', body)).toEqual([]);
  });

  it('drops a link Landfall would refuse rather than failing the delivery', () => {
    const body = toTriggerPayload(notice({ url: '/alerts/al_1' }), 'c');
    expect(body.url).toBeUndefined();
  });
});

describe("Landfall's answer", () => {
  const at = new Date('2026-11-14T15:04:00.000Z');

  it('becomes the room link', () => {
    expect(
      incidentLink({ outcome: 'opened', incidentId: 'inc_1', workspaceUrl: 'http://lf/o/x/incidents/inc_1' }, null, at),
    ).toEqual({
      system: 'landfall',
      id: 'inc_1',
      url: 'http://lf/o/x/incidents/inc_1',
      outcome: 'opened',
      at: at.toISOString(),
    });
  });

  it('keeps the room when an answer names none (a replay, an ignored recovery)', () => {
    const previous = incidentLink({ outcome: 'opened', incidentId: 'inc_1', workspaceUrl: 'u' }, null, at);
    expect(incidentLink({ outcome: 'ignored', incidentId: '', workspaceUrl: '' }, previous, at)).toMatchObject({
      id: 'inc_1',
      url: 'u',
      outcome: 'ignored',
    });
  });
});

describe('a landfall webhook', () => {
  const base = { url: 'http://127.0.0.1:3001/triggers', events: ['alert.firing', 'alert.resolved'] };

  it('needs the ingest token and the connection, and takes alert events only', () => {
    expect(WebhookInput.parse(base).format).toBe('standard');
    expect(WebhookInput.safeParse({ ...base, format: 'landfall' }).success).toBe(false);
    const landfall = { ingestToken: 't', connectionId: 'c' };
    expect(WebhookInput.safeParse({ ...base, format: 'landfall', landfall }).success).toBe(true);
    expect(WebhookInput.safeParse({ ...base, events: ['note.created'], format: 'landfall', landfall }).success).toBe(
      false,
    );
  });
});
