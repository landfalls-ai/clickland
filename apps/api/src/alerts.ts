import type { Alert, AlertEvent, AlertInput, IncidentLink, Severity } from '@clickland/contracts';
import type { TimeRange } from '@clickland/query';
import type { Sql } from './clients.js';
import type { Config } from './config.js';
import { notFound } from './errors.js';
import { newId } from './ids.js';
import { routeOf, toTriggerPayload } from './landfall.js';
import { type Telemetry, wrapSearchErrors } from './telemetry.js';
import type { Webhooks } from './webhooks.js';
import { compileSearch, SIGNALS } from '@clickland/query';

type AlertRow = {
  id: string;
  name: string;
  signal: 'logs' | 'traces';
  query: string;
  group_by: string | null;
  threshold_type: 'above' | 'below';
  threshold: number;
  window_minutes: number;
  interval_minutes: number;
  enabled: boolean;
  severity: Severity;
  direct: boolean;
  labels: Record<string, string>;
  runbook_url: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};
type StateRow = {
  alert_id: string;
  group_key: string;
  state: 'ok' | 'firing';
  value: number;
  changed_at: Date;
  incident: IncidentLink | null;
};
type EventRow = {
  id: string;
  alert_id: string;
  group_key: string;
  state: 'ok' | 'firing';
  value: number;
  threshold: number;
  window_start: Date;
  window_end: Date;
  created_at: Date;
  incident: IncidentLink | null;
};

const toAlert = (r: AlertRow, states: StateRow[]): Alert => ({
  id: r.id,
  name: r.name,
  signal: r.signal,
  query: r.query,
  groupBy: r.group_by,
  thresholdType: r.threshold_type,
  threshold: r.threshold,
  windowMinutes: r.window_minutes,
  intervalMinutes: r.interval_minutes,
  enabled: r.enabled,
  severity: r.severity,
  direct: r.direct,
  labels: r.labels ?? {},
  runbookUrl: r.runbook_url,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  states: states
    .filter((s) => s.alert_id === r.id)
    .map((s) => ({
      groupKey: s.group_key,
      state: s.state,
      value: s.value,
      changedAt: s.changed_at.toISOString(),
      incident: s.incident ?? null,
    })),
});

export const toEvent = (r: EventRow): AlertEvent => ({
  id: r.id,
  alertId: r.alert_id,
  groupKey: r.group_key,
  state: r.state,
  value: r.value,
  threshold: r.threshold,
  windowStart: r.window_start.toISOString(),
  windowEnd: r.window_end.toISOString(),
  createdAt: r.created_at.toISOString(),
  incident: r.incident ?? null,
});

export const breaches = (type: 'above' | 'below', value: number, threshold: number) =>
  type === 'above' ? value > threshold : value < threshold;

/** A search for one group of an alert: the alert's search plus `field:"value"`. */
export function groupSearch(query: string, groupBy: string | null, groupKey: string): string {
  if (!groupBy) return query;
  const clause = `${groupBy}:"${groupKey.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return query.trim() ? `(${query}) AND ${clause}` : clause;
}

/**
 * The values to compare: one per group seen in the window, plus every group that was firing (now 0 if it vanished,
 * so it resolves), and the single ungrouped series even when nothing matched (0, so `below` alerts can fire).
 */
export function groupValues(
  counts: { key: string; count: number }[],
  groupBy: string | null,
  known: string[],
): Map<string, number> {
  const values = new Map<string, number>();
  for (const c of counts) values.set(groupBy ? c.key : '', (values.get(groupBy ? c.key : '') ?? 0) + c.count);
  if (!groupBy && !values.has('')) values.set('', 0);
  for (const key of known) if (!values.has(key)) values.set(key, 0);
  return values;
}

export class Alerts {
  constructor(
    private readonly pg: Sql,
    private readonly telemetry: Telemetry,
    private readonly webhooks: Webhooks,
    private readonly config: Config,
  ) {}

  private validate(input: AlertInput) {
    wrapSearchErrors(() => compileSearch(SIGNALS[input.signal], input.query));
    if (input.groupBy) wrapSearchErrors(() => compileSearch(SIGNALS[input.signal], `${input.groupBy}:*`));
  }

  async list(): Promise<Alert[]> {
    const [rows, states] = await Promise.all([
      this.pg<AlertRow[]>`SELECT * FROM alerts ORDER BY name`,
      this.pg<StateRow[]>`SELECT * FROM alert_states ORDER BY group_key`,
    ]);
    return rows.map((r) => toAlert(r, states));
  }

  async get(id: string): Promise<Alert> {
    const [row] = await this.pg<AlertRow[]>`SELECT * FROM alerts WHERE id = ${id}`;
    if (!row) throw notFound('Alert');
    const states = await this.pg<StateRow[]>`SELECT * FROM alert_states WHERE alert_id = ${id} ORDER BY group_key`;
    return toAlert(row, states);
  }

  async create(input: AlertInput, createdBy: string): Promise<Alert> {
    this.validate(input);
    const id = newId('al');
    await this.pg`
      INSERT INTO alerts (id, name, signal, query, group_by, threshold_type, threshold, window_minutes, interval_minutes,
                          enabled, severity, direct, labels, runbook_url, created_by)
      VALUES (${id}, ${input.name}, ${input.signal}, ${input.query}, ${input.groupBy ?? null}, ${input.thresholdType},
              ${input.threshold}, ${input.windowMinutes}, ${input.intervalMinutes}, ${input.enabled},
              ${input.severity ?? 'sev3'}, ${input.direct ?? false}, ${this.pg.json(input.labels ?? {})},
              ${input.runbookUrl ?? null}, ${createdBy})`;
    return this.get(id);
  }

  /** Replaces the rule. An omitted `severity`, `direct`, `labels` or `runbookUrl` keeps its stored value. */
  async update(id: string, input: AlertInput): Promise<Alert> {
    this.validate(input);
    const [before] = await this.pg<Pick<AlertRow, 'signal' | 'query' | 'group_by'>[]>`
      SELECT signal, query, group_by FROM alerts WHERE id = ${id}`;
    if (!before) throw notFound('Alert');
    const pg = this.pg;
    await pg`
      UPDATE alerts SET name = ${input.name}, signal = ${input.signal}, query = ${input.query}, group_by = ${input.groupBy ?? null},
        threshold_type = ${input.thresholdType}, threshold = ${input.threshold}, window_minutes = ${input.windowMinutes},
        interval_minutes = ${input.intervalMinutes}, enabled = ${input.enabled},
        severity = ${input.severity === undefined ? pg`severity` : pg`${input.severity}`},
        direct = ${input.direct === undefined ? pg`direct` : pg`${input.direct}`},
        labels = ${input.labels === undefined ? pg`labels` : pg`${pg.json(input.labels)}`},
        runbook_url = ${input.runbookUrl === undefined ? pg`runbook_url` : pg`${input.runbookUrl}`},
        updated_at = now(), next_run_at = now()
      WHERE id = ${id}`;
    // A changed search makes the old groups meaningless: start again from "ok". Otherwise (a new name, threshold or
    // severity) the groups keep their state and their Landfall rooms.
    const searchChanged =
      before.signal !== input.signal || before.query !== input.query || (before.group_by ?? null) !== (input.groupBy ?? null);
    if (searchChanged) await pg`DELETE FROM alert_states WHERE alert_id = ${id}`;
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    const rows = await this.pg`DELETE FROM alerts WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw notFound('Alert');
  }

  async events(id: string, limit = 50): Promise<AlertEvent[]> {
    await this.get(id);
    const rows = await this.pg<
      EventRow[]
    >`SELECT * FROM alert_events WHERE alert_id = ${id} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map(toEvent);
  }

  async recentEvents(
    since: Date,
    limit = 50,
  ): Promise<(AlertEvent & { alertName: string; query: string; signal: string })[]> {
    const rows = await this.pg<(EventRow & { name: string; query: string; signal: string })[]>`
      SELECT e.*, a.name, a.query, a.signal FROM alert_events e JOIN alerts a ON a.id = e.alert_id
      WHERE e.created_at >= ${since} ORDER BY e.created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ ...toEvent(r), alertName: r.name, query: r.query, signal: r.signal }));
  }

  private window(row: AlertRow, now = new Date()): TimeRange {
    return { from: new Date(now.getTime() - row.window_minutes * 60_000), to: now };
  }

  /** What the alert would say now, without changing its state. */
  async test(id: string): Promise<{
    groups: { groupKey: string; value: number; wouldFire: boolean }[];
    window: { from: string; to: string };
  }> {
    const [row] = await this.pg<AlertRow[]>`SELECT * FROM alerts WHERE id = ${id}`;
    if (!row) throw notFound('Alert');
    const range = this.window(row);
    const counts = await this.telemetry.count(row.signal, row.query, range, row.group_by);
    const values = groupValues(counts, row.group_by, []);
    return {
      groups: [...values].map(([groupKey, value]) => ({
        groupKey,
        value,
        wouldFire: breaches(row.threshold_type, value, row.threshold),
      })),
      window: { from: range.from.toISOString(), to: range.to.toISOString() },
    };
  }

  /** Runs the alerts that are due. Each is claimed by moving `next_run_at`, so several API replicas don't double-fire. */
  async evaluateDue(limit = 20): Promise<number> {
    const due = await this.pg<AlertRow[]>`
      UPDATE alerts SET next_run_at = now() + make_interval(mins => interval_minutes)
      WHERE id IN (
        SELECT id FROM alerts WHERE enabled AND next_run_at <= now()
        ORDER BY next_run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      RETURNING *`;
    for (const row of due) {
      try {
        await this.evaluate(row);
      } catch (error) {
        console.error(`alert ${row.id} failed:`, error instanceof Error ? error.message : error);
      }
    }
    return due.length;
  }

  async evaluate(row: AlertRow, now = new Date()): Promise<AlertEvent[]> {
    const range = this.window(row, now);
    const counts = await this.telemetry.count(row.signal, row.query, range, row.group_by);
    const previous = await this.pg<StateRow[]>`SELECT * FROM alert_states WHERE alert_id = ${row.id}`;
    const before = new Map(previous.map((s) => [s.group_key, s]));
    const values = groupValues(
      counts,
      row.group_by,
      previous.filter((s) => s.state === 'firing').map((s) => s.group_key),
    );
    const changed: AlertEvent[] = [];
    for (const [groupKey, value] of values) {
      const state = breaches(row.threshold_type, value, row.threshold) ? 'firing' : 'ok';
      const was = before.get(groupKey)?.state ?? 'ok';
      if (state === was) {
        if (before.has(groupKey))
          await this
            .pg`UPDATE alert_states SET value = ${value}, evaluated_at = now() WHERE alert_id = ${row.id} AND group_key = ${groupKey}`;
        else if (state === 'ok' && !row.group_by) await this.upsertState(row.id, groupKey, state, value);
        continue;
      }
      await this.upsertState(row.id, groupKey, state, value);
      // On the direct route, the group's room (if it has one) is where this event goes: Landfall attaches a firing
      // with the same dedup key to the open room, and records a recovery on it. Shown as pending until it answers.
      const room = routeOf(row) === 'direct' ? before.get(groupKey)?.incident : null;
      const carried = room?.id ? { ...room, outcome: 'pending' as const, at: new Date().toISOString() } : null;
      const [event] = await this.pg<EventRow[]>`
        INSERT INTO alert_events (id, alert_id, group_key, state, value, threshold, window_start, window_end, incident)
        VALUES (${newId('ae')}, ${row.id}, ${groupKey}, ${state}, ${value}, ${row.threshold}, ${range.from}, ${range.to},
                ${carried ? this.pg.json(carried as never) : null})
        RETURNING *`;
      const alertEvent = toEvent(event!);
      changed.push(alertEvent);
      await this.notify(row, alertEvent, range);
    }
    // Groups that are "ok" and no longer seen are forgotten, so a high-cardinality group-by doesn't grow forever.
    await this
      .pg`DELETE FROM alert_states WHERE alert_id = ${row.id} AND state = 'ok' AND evaluated_at < now() - interval '1 day'`;
    return changed;
  }

  private async upsertState(alertId: string, groupKey: string, state: 'ok' | 'firing', value: number) {
    await this.pg`
      INSERT INTO alert_states (alert_id, group_key, state, value, changed_at, evaluated_at)
      VALUES (${alertId}, ${groupKey}, ${state}, ${value}, now(), now())
      ON CONFLICT (alert_id, group_key) DO UPDATE SET state = excluded.state, value = excluded.value,
        changed_at = CASE WHEN alert_states.state = excluded.state THEN alert_states.changed_at ELSE now() END,
        evaluated_at = now()`;
  }

  private async notify(row: AlertRow, event: AlertEvent, range: TimeRange) {
    const query = groupSearch(row.query, row.group_by, event.groupKey);
    const samples =
      event.state === 'firing' ? await this.telemetry.sampleRows(row.signal, query, range, 5).catch(() => []) : [];
    const searchUrl = `${this.config.consoleUrl}/search?${new URLSearchParams({
      signal: row.signal,
      query,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    })}`;
    const route = routeOf(row);
    const data = {
      alert: {
        id: row.id,
        name: row.name,
        signal: row.signal,
        query: row.query,
        groupBy: row.group_by,
        thresholdType: row.threshold_type,
        threshold: row.threshold,
        windowMinutes: row.window_minutes,
        severity: row.severity,
        direct: row.direct,
        labels: row.labels ?? {},
        runbookUrl: row.runbook_url,
      },
      eventId: event.id,
      status: event.state,
      route,
      groupKey: event.groupKey,
      value: event.value,
      fingerprint: `${row.id}:${event.groupKey}`,
      window: { from: event.windowStart, to: event.windowEnd },
      url: `${this.config.consoleUrl}/alerts/${row.id}`,
      searchUrl,
      samples,
      incident: event.incident,
    };
    await this.webhooks.enqueue(event.state === 'firing' ? 'alert.firing' : 'alert.resolved', data, row.id, {
      alertEventId: event.id,
      route,
      trigger: (connectionId) => toTriggerPayload({ ...data, occurredAt: event.createdAt }, connectionId),
    });
  }
}
