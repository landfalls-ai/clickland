import { useState } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';
import { Button, cn } from '@clickland/ui';
import { parseTime, PRESETS, rangeLabel, toLocalInput, type TimeRange } from '@/lib/time';
import { Popover } from './ui/popover';

/** Presets (last 5 minutes … 7 days) and a custom range. */
export function TimeRangePicker({
  value,
  onChange,
  className,
}: {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  className?: string;
}) {
  return (
    <Popover
      label="Time range"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className={cn(
            'inline-flex h-9 max-w-full items-center gap-2 rounded-[10px] border border-hair bg-wl px-3 text-[13px] text-t1 hover:border-bd',
            className,
          )}
          data-testid="time-range"
        >
          <Calendar className="size-3.5 shrink-0 text-t3" />
          <span className="truncate">{rangeLabel(value)}</span>
          <ChevronDown className="size-3.5 shrink-0 text-t3" />
        </button>
      )}
    >
      {(close) => <RangeForm value={value} onChange={(r) => (onChange(r), close())} />}
    </Popover>
  );
}

function RangeForm({ value, onChange }: { value: TimeRange; onChange: (range: TimeRange) => void }) {
  const [now] = useState(() => Date.now());
  const [from, setFrom] = useState(() => toLocalInput(parseTime(value.from, now)));
  const [to, setTo] = useState(() => toLocalInput(parseTime(value.to, now)));
  const valid = from && to && new Date(from).getTime() < new Date(to).getTime();
  return (
    <div className="flex flex-col gap-3 md:flex-row">
      <div className="grid grid-cols-3 gap-1 md:flex md:w-40 md:flex-col">
        {PRESETS.map((p) => (
          <button
            key={p.from}
            type="button"
            onClick={() => onChange({ from: p.from, to: 'now' })}
            className={cn(
              'rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-acdim',
              value.from === p.from && value.to === 'now' ? 'bg-acdim font-semibold text-t1' : 'text-t2',
            )}
          >
            <span className="md:hidden">{p.short}</span>
            <span className="hidden md:inline">{p.label}</span>
          </button>
        ))}
      </div>
      <form
        className="flex flex-col gap-2 border-t border-hair pt-3 md:w-56 md:border-l md:border-t-0 md:pl-3 md:pt-0"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onChange({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
        }}
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Custom</span>
        <label className="flex flex-col gap-1 text-[12px] text-t2">
          From
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 rounded-[10px] border border-hair bg-wl px-2 text-[13px] text-t1 outline-none focus:border-ac"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-t2">
          To
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 rounded-[10px] border border-hair bg-wl px-2 text-[13px] text-t1 outline-none focus:border-ac"
          />
        </label>
        <Button type="submit" size="sm" variant="primary" disabled={!valid} className="self-end">
          Apply
        </Button>
      </form>
    </div>
  );
}
