import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Clock, RefreshCw } from 'lucide-react';
import type { Panel, ViewSpec } from '@clickland/contracts';
import { cn } from '../cn';
import type { DataSource, PanelLinks } from '../data';
import { formatRange } from '../format';
import { Button } from '../primitives/button';
import { resolveRange, type TimeBounds } from '../time';
import { Markdown } from './markdown';
import { PanelView } from './panel-view';

export interface ViewGridProps {
  spec: ViewSpec;
  data: DataSource;
  links?: PanelLinks;
  /** Show the title, description and range above the panels (default true). */
  header?: boolean;
  /** Buttons on the header's right (Open, Save as dashboard, Edit). */
  actions?: ReactNode;
  /** Extra controls per panel (the editor). */
  panelActions?: (panel: Panel, index: number) => ReactNode;
  /** How often a relative range moves forward and the panels reload (default 30 s; 0 turns it off). */
  refreshMs?: number;
  className?: string;
}

/**
 * A view's panels in a grid: two columns when the container is wide enough (a `half` panel takes one, `full` both),
 * one column on a phone or in a narrow chat card. It sizes on its container, not the window, so the same grid fits
 * a page, a side card and an MCP App's iframe.
 */
export function ViewGrid({
  spec,
  data,
  links,
  header = true,
  actions,
  panelActions,
  refreshMs = 30_000,
  className,
}: ViewGridProps) {
  const rangeKey = JSON.stringify(spec.range);
  const relative = 'lastMinutes' in spec.range;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!relative || !refreshMs) return;
    const id = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [relative, refreshMs]);
  // A relative range is resolved when it changes and on each tick.
  const range: TimeBounds = useMemo(
    () => resolveRange(JSON.parse(rangeKey) as ViewSpec['range']),
    // tick moves the window forward
    [rangeKey, tick],
  );

  return (
    <div className={cn('@container flex min-w-0 flex-col gap-3', className)} data-testid="view-grid">
      {header && (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold leading-tight text-t1">{spec.title}</h2>
            {spec.description && <Markdown text={spec.description} className="mt-0.5 text-[13px] text-t2" />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-hair px-2.5 py-0.5 text-[12px] text-t2">
              <Clock className="size-3.5 text-t3" />
              {formatRange(spec.range)}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh"
              title="Refresh"
              onClick={() => setTick((t) => t + 1)}
            >
              <RefreshCw className="size-3.5" />
            </Button>
            {actions}
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
        {spec.panels.map((panel, i) => (
          <PanelView
            key={panel.id ?? `${i}-${panel.type}`}
            panel={panel}
            range={range}
            data={data}
            links={links}
            refresh={tick}
            actions={panelActions?.(panel, i)}
            className={panel.width === 'full' ? '@2xl:col-span-2' : undefined}
          />
        ))}
      </div>
    </div>
  );
}
