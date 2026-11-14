import { useNavigate, useParams } from 'react-router';
import { Check, LayoutDashboard, Pencil } from 'lucide-react';
import { Button, ErrorNote, Skeleton, ViewGrid } from '@clickland/ui';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { httpData } from '@/lib/http-data';
import { useConsoleLinks } from '@/lib/links';
import { api, useView, useWrite } from '@/lib/queries';

/**
 * /dashboards/:id and /views/:id : a view drawn live over HTTP. A dashboard (pinned) has Edit; a view that isn't
 * pinned has Save as dashboard.
 */
export function ViewPage({ kind }: { kind: 'dashboard' | 'view' }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const canEdit = useCan('edit');
  const view = useView(id);
  const pin = useWrite(api.updateView, ['views']);
  const links = useConsoleLinks(view.data?.spec.range ?? { lastMinutes: 60 });

  if (view.isLoading) return <Skeleton lines={10} className="p-6" />;
  if (view.error)
    return (
      <ErrorNote
        className="m-6"
        error={view.error instanceof ApiError && view.error.status === 404 ? `There is no ${kind} ${id}.` : view.error}
      />
    );
  if (!view.data) return null;
  const pinned = view.data.pinned || pin.isSuccess;

  return (
    <>
      <PageHeader
        title={view.data.title || view.data.spec.title}
        meta={<span className="hidden md:inline">{pinned ? 'Dashboard' : 'View'}</span>}
        actions={
          <>
            {canEdit && pinned && kind === 'dashboard' && (
              <Button size="sm" onClick={() => navigate(`/dashboards/${id}/edit`)}>
                <Pencil className="size-3.5" /> Edit
              </Button>
            )}
            {pinned && kind === 'view' && (
              <Button size="sm" onClick={() => navigate(`/dashboards/${id}`)}>
                <Check className="size-3.5" /> Open dashboard
              </Button>
            )}
            {canEdit && !pinned && (
              <Button
                size="sm"
                variant="primary"
                loading={pin.isPending}
                onClick={() => pin.mutate({ id, pinned: true, version: view.data.version })}
              >
                <LayoutDashboard className="size-3.5" /> Save as dashboard
              </Button>
            )}
          </>
        }
      />
      <PageBody>
        {pin.error && <ErrorNote error={pin.error} className="mb-3" />}
        <ViewGrid spec={view.data.spec} data={httpData} links={links} header={false} />
        {view.data.spec.description && <p className="sr-only">{view.data.spec.description}</p>}
      </PageBody>
    </>
  );
}
