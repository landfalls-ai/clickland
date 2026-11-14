import { Link, useNavigate } from 'react-router';
import { LayoutDashboard, Plus } from 'lucide-react';
import { Button, Card, EmptyState, ErrorNote, formatTime, Skeleton } from '@clickland/ui';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { useCan } from '@/lib/auth';
import { useViews } from '@/lib/queries';

/** Pinned views: the dashboards. */
export function DashboardsPage() {
  const views = useViews(true);
  const canEdit = useCan('edit');
  const navigate = useNavigate();
  const list = views.data?.views ?? [];
  return (
    <>
      <PageHeader
        title="Dashboards"
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => navigate('/dashboards/new')}>
              <Plus className="size-3.5" /> New dashboard
            </Button>
          )
        }
      />
      <PageBody>
        {views.isLoading ? (
          <Skeleton lines={5} />
        ) : views.error ? (
          <ErrorNote error={views.error} />
        ) : !list.length ? (
          <Card>
            <EmptyState
              icon={<LayoutDashboard className="size-5" />}
              title="No dashboards yet"
              hint="Build one here, or ask the assistant for a view and save it as a dashboard."
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3" data-testid="dashboard-list">
            {list.map((v) => (
              <Link key={v.id} to={`/dashboards/${v.id}`}>
                <Card className="flex h-full flex-col gap-1 hover:border-bd">
                  <span className="flex items-center gap-2 text-[14px] font-semibold text-t1">
                    <LayoutDashboard className="size-4 text-t3" strokeWidth={1.7} />
                    <span className="truncate">{v.title}</span>
                  </span>
                  <span className="text-[12px] text-t3">
                    {v.createdBy} · {formatTime(v.updatedAt ?? v.createdAt, { date: true, ms: false })}
                  </span>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}
