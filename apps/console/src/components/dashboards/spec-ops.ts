import { Panel, type ViewSpec } from '@clickland/contracts';
import type { PanelType } from '@clickland/ui';

/** Pure edits of a view spec: the editor's buttons and drag call these, and the tests check them. */

const shortId = () => `p_${Math.random().toString(36).slice(2, 8)}`;

/** A new panel of a type, with sensible defaults (it passes the contract as it is, except a trace needs an id). */
export function newPanel(type: PanelType, id: string = shortId()): Panel {
  const base = { id, width: 'half' as const };
  switch (type) {
    case 'timeseries':
      return { ...base, type, title: 'Errors over time', signal: 'logs', query: 'level:error', groupBy: 'service' };
    case 'bar':
      return { ...base, type, title: 'Errors by service', signal: 'logs', query: 'level:error', groupBy: 'service' };
    case 'stat':
      return { ...base, type, title: 'Error count', signal: 'logs', query: 'level:error' };
    case 'logs':
      return { ...base, type, title: 'Latest errors', query: 'level:error', limit: 25, width: 'full' };
    case 'spans':
      return { ...base, type, title: 'Slow spans', query: 'duration:>500', limit: 25, width: 'full' };
    case 'trace':
      return { ...base, type, title: 'A trace', traceId: '', width: 'full' } as unknown as Panel;
    case 'services':
      return { ...base, type, title: 'Services', width: 'full' };
    case 'patterns':
      return { ...base, type, title: 'Error patterns', signal: 'logs', query: 'level:error' };
    case 'metric':
      return {
        ...base,
        type,
        title: 'Metric',
        metric: '',
        metricType: 'gauge',
        aggregation: 'avg',
      } as unknown as Panel;
    case 'markdown':
      return { ...base, type, title: 'Notes', text: '' };
  }
}

/** A panel turned into another type: keeps its id, title, width, and the search when both types have one. */
export function convertPanel(panel: Panel, type: PanelType): Panel {
  if (panel.type === type) return panel;
  const next = newPanel(type, panel.id) as Record<string, unknown>;
  const old = panel as Record<string, unknown>;
  for (const key of ['title', 'width', 'query', 'signal', 'groupBy'] as const) {
    if (key in next && old[key] !== undefined && old[key] !== null) next[key] = old[key];
  }
  if (type === 'bar' && !next.groupBy) next.groupBy = 'service';
  return next as Panel;
}

export function addPanel(spec: ViewSpec, panel: Panel, position?: number): ViewSpec {
  const panels = [...spec.panels];
  panels.splice(position ?? panels.length, 0, panel);
  return { ...spec, panels };
}

export function updatePanel(spec: ViewSpec, index: number, panel: Panel): ViewSpec {
  return { ...spec, panels: spec.panels.map((p, i) => (i === index ? panel : p)) };
}

export function removePanel(spec: ViewSpec, index: number): ViewSpec {
  return { ...spec, panels: spec.panels.filter((_, i) => i !== index) };
}

/** Moves the panel at `from` to `to` (both indexes in the current list). */
export function movePanel(spec: ViewSpec, from: number, to: number): ViewSpec {
  if (from === to || from < 0 || from >= spec.panels.length) return spec;
  const panels = [...spec.panels];
  const [moved] = panels.splice(from, 1);
  panels.splice(Math.max(0, Math.min(to, panels.length)), 0, moved!);
  return { ...spec, panels };
}

/** Gives every panel an id (stable keys while editing; the contract allows them). */
export function withIds(spec: ViewSpec): ViewSpec {
  return spec.panels.every((p) => p.id)
    ? spec
    : { ...spec, panels: spec.panels.map((p) => (p.id ? p : { ...p, id: shortId() })) };
}

/** A panel checked against the contract: the parsed panel, or the first problem. */
export function checkPanel(panel: Panel): { ok: true; panel: Panel } | { ok: false; message: string } {
  const parsed = Panel.safeParse(panel);
  if (parsed.success) return { ok: true, panel: parsed.data };
  const issue = parsed.error.issues[0]!;
  return { ok: false, message: `${issue.path.join('.') || 'panel'}: ${issue.message}` };
}
