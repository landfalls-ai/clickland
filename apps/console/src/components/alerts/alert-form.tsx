import { useState, type ReactNode } from 'react';
import { AlertInput } from '@clickland/contracts';
import { ErrorNote, Field, Input, Segmented, Switch } from '@clickland/ui';

export type AlertDraft = AlertInput;

export const NEW_ALERT: AlertDraft = {
  name: '',
  signal: 'logs',
  query: 'level:error',
  groupBy: null,
  thresholdType: 'above',
  threshold: 10,
  windowMinutes: 5,
  intervalMinutes: 1,
  enabled: true,
};

/** Checks a draft against the contract; the first problem as a sentence, or the parsed input. */
export function validateAlert(draft: AlertDraft): { ok: true; value: AlertInput } | { ok: false; message: string } {
  const parsed = AlertInput.safeParse({ ...draft, groupBy: draft.groupBy || null });
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0]!;
  return { ok: false, message: `${issue.path.join('.') || 'alert'}: ${issue.message}` };
}

/** "above 10 in 5 min, every 1 min, per service" */
export function describeAlert(a: AlertInput): string {
  return `${a.thresholdType} ${a.threshold} in ${a.windowMinutes} min, every ${a.intervalMinutes} min${a.groupBy ? `, per ${a.groupBy}` : ''}`;
}

/** The alert's fields: search, group-by, above/below a threshold, window and interval. */
export function AlertForm({
  value,
  onChange,
  readOnly,
  error,
  footer,
}: {
  value: AlertDraft;
  onChange: (value: AlertDraft) => void;
  readOnly?: boolean;
  error?: unknown;
  footer?: ReactNode;
}) {
  const set = <K extends keyof AlertDraft>(key: K, v: AlertDraft[K]) => onChange({ ...value, [key]: v });
  const [touched, setTouched] = useState(false);
  const check = validateAlert(value);
  return (
    <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-3" onBlur={() => setTouched(true)}>
      <Field label="Name">
        <Input value={value.name} onChange={(e) => set('name', e.target.value)} placeholder="API errors" required />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Signal">
          <Segmented
            label="Signal"
            value={value.signal}
            onChange={(s) => set('signal', s)}
            options={[
              { value: 'logs', label: 'Logs' },
              { value: 'traces', label: 'Traces' },
            ]}
          />
        </Field>
        <Field label="Enabled">
          <span className="flex h-9 items-center">
            <Switch checked={value.enabled} onChange={(v) => set('enabled', v)} label="Enabled" disabled={readOnly} />
          </span>
        </Field>
      </div>
      <Field label="Search" hint="The rows the alert counts, in the search language.">
        <Input value={value.query} onChange={(e) => set('query', e.target.value)} className="font-mono" spellCheck={false} />
      </Field>
      <Field label="Group by" hint="Optional: count per value of a field (each value fires on its own).">
        <Input
          value={value.groupBy ?? ''}
          onChange={(e) => set('groupBy', e.target.value || null)}
          placeholder="service"
          className="font-mono"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Fires when">
          <Segmented
            label="Threshold type"
            value={value.thresholdType}
            onChange={(t) => set('thresholdType', t)}
            options={[
              { value: 'above', label: 'Above' },
              { value: 'below', label: 'Below' },
            ]}
          />
        </Field>
        <Field label="Threshold">
          <Input type="number" inputMode="decimal" value={Number.isFinite(value.threshold) ? value.threshold : ''} onChange={(e) => set('threshold', e.target.valueAsNumber)} />
        </Field>
        <Field label="Window (min)">
          <Input type="number" inputMode="numeric" min={1} max={1440} value={value.windowMinutes || ''} onChange={(e) => set('windowMinutes', e.target.valueAsNumber)} />
        </Field>
        <Field label="Every (min)">
          <Input type="number" inputMode="numeric" min={1} max={1440} value={value.intervalMinutes || ''} onChange={(e) => set('intervalMinutes', e.target.valueAsNumber)} />
        </Field>
      </div>
      {touched && !check.ok && !readOnly && <p className="text-[12px] text-warn">{check.message}</p>}
      <ErrorNote error={error} />
      {footer}
    </fieldset>
  );
}
