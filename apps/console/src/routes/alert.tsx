import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { FlaskConical, Search, Trash2 } from 'lucide-react';
import type { Alert } from '@clickland/contracts';
import { Badge, Button, Card, ErrorNote, formatCount, formatTime, SectionLabel, Skeleton } from '@clickland/ui';
import { AlertForm, NEW_ALERT, validateAlert, type AlertDraft } from '@/components/alerts/alert-form';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useCan } from '@/lib/auth';
import { api, useAlert, useAlertEvents, useWrite } from '@/lib/queries';
import { alertState } from './alerts';

const draftOf = (a: Alert): AlertDraft => ({
  name: a.name,
  signal: a.signal,
  query: a.query,
  groupBy: a.groupBy ?? null,
  thresholdType: a.thresholdType,
  threshold: a.threshold,
  windowMinutes: a.windowMinutes,
  intervalMinutes: a.intervalMinutes,
  enabled: a.enabled,
});

/** /alerts/new and /alerts/:id : the form, Test, the current states and the event history. */
export function AlertPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const canEdit = useCan('edit');
  const alert = useAlert(isNew ? undefined : id);
  const events = useAlertEvents(isNew ? undefined : id);
  const [draft, setDraft] = useState<AlertDraft | null>(isNew ? NEW_ALERT : null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const current = draft ?? (alert.data ? draftOf(alert.data) : null);
  const dirty = Boolean(draft && alert.data && JSON.stringify(draft) !== JSON.stringify(draftOf(alert.data)));

  const create = useWrite(api.createAlert, ['alerts']);
  const update = useWrite(api.updateAlert, ['alerts']);
  const remove = useWrite(api.deleteAlert, ['alerts']);
  const test = useWrite(api.testAlert, []);

  // "Save and test" lands here with ?test=1: run the test once.
  const autoTested = useRef(false);
  useEffect(() => {
    if (!isNew && id && params.get('test') === '1' && !autoTested.current) {
      autoTested.current = true;
      test.mutate(id);
      const p = new URLSearchParams(params);
      p.delete('test');
      setParams(p, { replace: true });
    }
  }, [id, isNew, params, setParams, test]);

  const save = async (andTest: boolean) => {
    if (!current) return;
    const check = validateAlert(current);
    if (!check.ok) return setProblem(check.message);
    setProblem(null);
    if (isNew) {
      const created = await create.mutateAsync(check.value);
      navigate(`/alerts/${created.id}${andTest ? '?test=1' : ''}`, { replace: true });
    } else {
      await update.mutateAsync({ id: id!, input: check.value });
      setDraft(null);
      if (andTest) test.mutate(id!);
    }
  };

  if (!isNew && alert.isLoading) return <Skeleton lines={10} className="p-6" />;
  if (!isNew && alert.error) return <ErrorNote error={alert.error} className="m-6" />;
  if (!current) return null;
  const state = alert.data ? alertState(alert.data) : null;
  const searchHref = `/search?${new URLSearchParams({ signal: current.signal, query: current.query, from: `now-${current.windowMinutes}m`, to: 'now' })}`;

  return (
    <>
      <PageHeader
        title={isNew ? 'New alert' : alert.data?.name}
        meta={state && <Badge tone={state.tone}>{state.label}</Badge>}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => navigate(searchHref)}>
              <Search className="size-3.5" /> Search
            </Button>
            {!isNew && canEdit && (
              <Button size="sm" variant="ghost" aria-label="Delete the alert" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </>
        }
      />
      <PageBody className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-start">
        <Card>
          <AlertForm
            value={current}
            onChange={setDraft}
            readOnly={!canEdit}
            error={problem ?? create.error ?? update.error}
            footer={
              canEdit && (
                <div className="flex flex-wrap justify-end gap-2 pt-1">
                  {!isNew && dirty && (
                    <Button variant="ghost" onClick={() => setDraft(null)}>
                      Discard changes
                    </Button>
                  )}
                  {(isNew || dirty) && (
                    <Button onClick={() => void save(true)} loading={(create.isPending || update.isPending) && test.isIdle}>
                      <FlaskConical className="size-3.5" /> {isNew ? 'Create and test' : 'Save and test'}
                    </Button>
                  )}
                  {!isNew && !dirty && (
                    <Button onClick={() => test.mutate(id!)} loading={test.isPending}>
                      <FlaskConical className="size-3.5" /> Test
                    </Button>
                  )}
                  {(isNew || dirty) && (
                    <Button variant="primary" onClick={() => void save(false)} loading={create.isPending || update.isPending}>
                      {isNew ? 'Create alert' : 'Save'}
                    </Button>
                  )}
                </div>
              )
            }
          />
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          {(test.data || test.error || test.isPending) && (
            <Card testId="test-result">
              <SectionLabel className="mb-2">Test (state unchanged)</SectionLabel>
              {test.isPending ? (
                <Skeleton lines={2} />
              ) : test.error ? (
                <ErrorNote error={test.error} />
              ) : test.data && !test.data.groups.length ? (
                <p className="text-[13px] text-t2">No rows matched in the window: the count is 0.</p>
              ) : (
                <div className="flex flex-col">
                  {test.data?.groups.map((g) => (
                    <div key={g.groupKey} className="flex items-center gap-2 border-b border-hair py-1.5 text-[13px] last:border-0">
                      <span className="min-w-0 flex-1 truncate font-mono text-t1">{g.groupKey || '(all rows)'}</span>
                      <span className="font-mono text-t2">{formatCount(g.value)}</span>
                      <Badge tone={g.wouldFire ? 'danger' : 'success'}>{g.wouldFire ? 'would fire' : 'ok'}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
          {alert.data && alert.data.states.length > 0 && (
            <Card>
              <SectionLabel className="mb-2">Now</SectionLabel>
              {alert.data.states.map((s) => (
                <div key={s.groupKey} className="flex items-center gap-2 border-b border-hair py-1.5 text-[13px] last:border-0">
                  <Badge tone={s.state === 'firing' ? 'danger' : 'success'}>{s.state}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-t1">{s.groupKey || '(all rows)'}</span>
                  <span className="font-mono text-t2">{formatCount(s.value)}</span>
                  <span className="text-[11px] text-t3">{formatTime(s.changedAt, { date: true, ms: false })}</span>
                </div>
              ))}
            </Card>
          )}
          {!isNew && (
            <Card>
              <SectionLabel className="mb-2">History</SectionLabel>
              {events.isLoading ? (
                <Skeleton lines={3} />
              ) : events.error ? (
                <ErrorNote error={events.error} />
              ) : !events.data?.events.length ? (
                <p className="text-[13px] text-t3">No state changes yet.</p>
              ) : (
                <ol className="flex flex-col" data-testid="alert-events">
                  {events.data.events.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-hair py-1.5 text-[13px] last:border-0">
                      <Badge tone={e.state === 'firing' ? 'danger' : 'success'}>{e.state === 'firing' ? 'fired' : 'resolved'}</Badge>
                      <span className="font-mono text-t1">{e.groupKey || '(all rows)'}</span>
                      <span className="font-mono text-t2">
                        {formatCount(e.value)} / {formatCount(e.threshold)}
                      </span>
                      <span className="ml-auto text-[11px] text-t3">{formatTime(e.createdAt, { date: true, ms: false })}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}
        </div>
      </PageBody>
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this alert?"
          message="Its history goes with it, and webhooks stop hearing about it."
          action="Delete"
          busy={remove.isPending}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => remove.mutate(id!, { onSuccess: () => navigate('/alerts') })}
        />
      )}
    </>
  );
}
