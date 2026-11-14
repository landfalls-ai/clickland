import { useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Panel, ViewSpec } from '@clickland/contracts';
import { Button, cn, ErrorNote, Field, Input, PANEL_TYPES, Select, Textarea, type PanelType } from '@clickland/ui';
import type { MetricName } from '@/lib/types';
import { Dialog } from '../ui/dialog';
import { PanelForm, TypePicker } from './panel-form';
import { addPanel, checkPanel, movePanel, newPanel, removePanel, updatePanel } from './spec-ops';

const RANGES = [
  { minutes: 15, label: 'Last 15 minutes' },
  { minutes: 60, label: 'Last hour' },
  { minutes: 240, label: 'Last 4 hours' },
  { minutes: 1440, label: 'Last 24 hours' },
  { minutes: 10080, label: 'Last 7 days' },
];

type Editing = { index: number | null; panel: Panel } | { picking: true };

/**
 * The dashboard editor: rename, describe, pick the range; add a panel from the type picker, edit or remove one,
 * reorder by the arrows or by dragging, switch half/full width. It edits a spec and hands every change to
 * `onChange`; saving is the page's job.
 */
export function DashboardEditor({
  spec,
  onChange,
  metrics,
}: {
  spec: ViewSpec;
  onChange: (spec: ViewSpec) => void;
  metrics?: MetricName[];
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const relativeMinutes = 'lastMinutes' in spec.range ? spec.range.lastMinutes : null;

  const commit = () => {
    if (!editing || 'picking' in editing) return;
    const check = checkPanel(editing.panel);
    if (!check.ok) return setProblem(check.message);
    onChange(editing.index === null ? addPanel(spec, check.panel) : updatePanel(spec, editing.index, check.panel));
    setEditing(null);
    setProblem(null);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="dashboard-editor">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
        <Field label="Name">
          <Input value={spec.title} onChange={(e) => onChange({ ...spec, title: e.target.value })} aria-label="Dashboard name" />
        </Field>
        <Field label="Time range">
          <Select
            value={relativeMinutes === null ? 'fixed' : String(relativeMinutes)}
            onChange={(e) => e.target.value !== 'fixed' && onChange({ ...spec, range: { lastMinutes: Number(e.target.value) } })}
            aria-label="Time range"
          >
            {relativeMinutes !== null && !RANGES.some((r) => r.minutes === relativeMinutes) && (
              <option value={relativeMinutes}>Last {relativeMinutes} min</option>
            )}
            {relativeMinutes === null && <option value="fixed">Fixed range</option>}
            {RANGES.map((r) => (
              <option key={r.minutes} value={r.minutes}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Description">
        <Textarea
          rows={2}
          value={spec.description ?? ''}
          onChange={(e) => onChange({ ...spec, description: e.target.value || undefined })}
          aria-label="Description"
        />
      </Field>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-t2">Panels</span>
          <span className="text-[11px] text-t3">{spec.panels.length} of 12</span>
          <Button
            size="sm"
            className="ml-auto"
            disabled={spec.panels.length >= 12}
            onClick={() => setEditing({ picking: true })}
          >
            <Plus className="size-3.5" /> Add panel
          </Button>
        </div>
        {!spec.panels.length && (
          <p className="rounded-xl border border-dashed border-bd px-3 py-6 text-center text-[13px] text-t3">
            No panels yet. Add one to save the dashboard.
          </p>
        )}
        <ol className="flex flex-col gap-1.5" aria-label="Panels">
          {spec.panels.map((panel, i) => {
            const meta = PANEL_TYPES[panel.type];
            const Icon = meta.icon;
            return (
              <li
                key={panel.id ?? i}
                data-testid="editor-panel"
                draggable
                onDragStart={(e) => {
                  setDragFrom(i);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(i));
                }}
                onDragOver={(e) => {
                  if (dragFrom === null) return;
                  e.preventDefault();
                  setDragOver(i);
                }}
                onDragLeave={() => setDragOver((o) => (o === i ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragFrom ?? Number(e.dataTransfer.getData('text/plain'));
                  if (Number.isInteger(from)) onChange(movePanel(spec, from, i));
                  setDragFrom(null);
                  setDragOver(null);
                }}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDragOver(null);
                }}
                className={cn(
                  'flex items-center gap-2 rounded-xl border bg-sf px-2 py-1.5',
                  dragOver === i && dragFrom !== i ? 'border-ac' : 'border-hair',
                  dragFrom === i && 'opacity-50',
                )}
              >
                <GripVertical className="hidden size-4 shrink-0 cursor-grab text-t3 md:block" aria-hidden />
                <Icon className="size-4 shrink-0 text-t2" strokeWidth={1.8} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-t1">{panel.title}</div>
                  <div className="truncate text-[11px] text-t3">
                    {meta.label}
                    {'query' in panel && panel.query ? ` · ${panel.query}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onChange(updatePanel(spec, i, { ...panel, width: panel.width === 'full' ? 'half' : 'full' }))}
                  title="Width"
                  aria-label={`Width of ${panel.title}: ${panel.width ?? 'half'}`}
                  className="hidden h-6 rounded-full border border-hair px-2 text-[11px] text-t2 hover:border-bd md:block"
                >
                  {panel.width === 'full' ? 'full' : 'half'}
                </button>
                <Button size="icon-sm" variant="ghost" aria-label={`Move ${panel.title} up`} disabled={i === 0} onClick={() => onChange(movePanel(spec, i, i - 1))}>
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${panel.title} down`}
                  disabled={i === spec.panels.length - 1}
                  onClick={() => onChange(movePanel(spec, i, i + 1))}
                >
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Edit ${panel.title}`} onClick={() => setEditing({ index: i, panel })}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Remove ${panel.title}`} onClick={() => onChange(removePanel(spec, i))}>
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            );
          })}
        </ol>
      </div>

      {editing && 'picking' in editing && (
        <Dialog title="Add a panel" onClose={() => setEditing(null)} width={620}>
          <TypePicker onPick={(type: PanelType) => setEditing({ index: null, panel: newPanel(type) })} />
        </Dialog>
      )}
      {editing && !('picking' in editing) && (
        <Dialog
          title={editing.index === null ? `New ${PANEL_TYPES[editing.panel.type].label.toLowerCase()} panel` : 'Edit panel'}
          onClose={() => {
            setEditing(null);
            setProblem(null);
          }}
          onSubmit={commit}
          width={560}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit">
                {editing.index === null ? 'Add panel' : 'Done'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <PanelForm value={editing.panel} onChange={(panel) => setEditing({ ...editing, panel })} metrics={metrics} />
            <ErrorNote error={problem} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
