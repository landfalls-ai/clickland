import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Bell, LayoutTemplate, Plus } from 'lucide-react';
import type { Alert } from '@clickland/contracts';
import { Badge, Button, Card, EmptyState, ErrorNote, Skeleton, type Tone } from '@clickland/ui';
import { describeAlert } from '@/components/alerts/alert-form';
import { AlertTemplatesDialog } from '@/components/alerts/alert-templates';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { useCan } from '@/lib/auth';
import { useAlerts } from '@/lib/queries';

/** An alert's state chip: firing (how many groups), ok, or off. */
export function alertState(alert: Alert): { label: string; tone: Tone } {
  if (!alert.enabled) return { label: 'off', tone: 'muted' };
  const firing = alert.states.filter((s) => s.state === 'firing').length;
  if (firing)
    return { label: alert.groupBy && alert.states.length > 1 ? `firing · ${firing}` : 'firing', tone: 'danger' };
  if (!alert.states.length) return { label: 'pending', tone: 'neutral' };
  return { label: 'ok', tone: 'success' };
}

export function AlertsPage() {
  const alerts = useAlerts();
  const canEdit = useCan('edit');
  const navigate = useNavigate();
  const [templates, setTemplates] = useState(false);
  const list = [...(alerts.data?.alerts ?? [])].sort(
    (a, b) =>
      Number(alertState(b).tone === 'danger') - Number(alertState(a).tone === 'danger') || a.name.localeCompare(b.name),
  );
  return (
    <>
      <PageHeader
        title="Alerts"
        actions={
          canEdit && (
            <>
              <Button onClick={() => setTemplates(true)}>
                <LayoutTemplate className="size-3.5" /> From a template
              </Button>
              <Button variant="primary" onClick={() => navigate('/alerts/new')}>
                <Plus className="size-3.5" /> New alert
              </Button>
            </>
          )
        }
      />
      <PageBody>
        {alerts.isLoading ? (
          <Skeleton lines={6} />
        ) : alerts.error ? (
          <ErrorNote error={alerts.error} />
        ) : !list.length ? (
          <Card>
            <EmptyState
              icon={<Bell className="size-5" />}
              title="No alerts yet"
              hint="An alert counts the rows that match a search in a sliding window and fires when the count crosses a threshold; webhooks hear about it."
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-2" data-testid="alert-list">
            {list.map((a) => {
              const state = alertState(a);
              return (
                <Link key={a.id} to={`/alerts/${a.id}`} className="block">
                  <Card className="flex flex-col gap-1.5 hover:border-bd md:flex-row md:items-center md:gap-4">
                    <div className="flex min-w-0 items-center gap-2 md:w-64">
                      <Badge tone={state.tone}>{state.label}</Badge>
                      <span className="truncate text-[14px] font-semibold text-t1">{a.name}</span>
                    </div>
                    <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t2">
                      <span className="text-t3">{a.signal}:</span> {a.query || '*'}
                    </code>
                    <span className="text-[12px] text-t3">{describeAlert(a)}</span>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </PageBody>
      {templates && <AlertTemplatesDialog onClose={() => setTemplates(false)} />}
    </>
  );
}
