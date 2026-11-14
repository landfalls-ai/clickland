import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { ViewSpec } from '@clickland/contracts';
import { Button, Card, ErrorNote, SectionLabel, Skeleton, ViewGrid } from '@clickland/ui';
import { DashboardEditor } from '@/components/dashboards/editor';
import { withIds } from '@/components/dashboards/spec-ops';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { ConfirmDialog } from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { httpData } from '@/lib/http-data';
import { useConsoleLinks } from '@/lib/links';
import { api, useMetricNames, useView, useWrite } from '@/lib/queries';
import { resolve } from '@/lib/time';

const EMPTY: ViewSpec = { title: 'Untitled dashboard', range: { lastMinutes: 60 }, panels: [] as never };

/** /dashboards/new and /dashboards/:id/edit : the editor with a live preview; Save is a PUT with `version`. */
export function DashboardEditPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const canEdit = useCan('edit');
  const view = useView(id);
  const [draft, setDraft] = useState<ViewSpec | null>(isNew ? EMPTY : null);
  const [now] = useState(() => Date.now());
  const metrics = useMetricNames(resolve({ from: 'now-24h', to: 'now' }, now));
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const create = useWrite(api.createView, ['views']);
  const update = useWrite(api.updateView, ['views']);
  const remove = useWrite(api.deleteView, ['views']);
  const spec = draft ?? (view.data ? withIds(view.data.spec) : null);
  const links = useConsoleLinks(spec?.range ?? { lastMinutes: 60 });

  if (!canEdit) return <ErrorNote className="m-6" error="Your role can view dashboards but not change them." />;
  if (!isNew && view.isLoading) return <Skeleton lines={10} className="p-6" />;
  if (!isNew && view.error) return <ErrorNote className="m-6" error={view.error} />;
  if (!spec) return null;

  const save = async (force = false) => {
    setConflict(false);
    try {
      if (isNew) {
        const created = await create.mutateAsync({ spec, pinned: true });
        navigate(`/dashboards/${created.id}`, { replace: true });
      } else {
        await update.mutateAsync({
          id: id!,
          spec,
          title: spec.title,
          ...(force ? {} : { version: view.data?.version }),
        });
        navigate(`/dashboards/${id}`);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
    }
  };
  const busy = create.isPending || update.isPending;
  const error = conflict ? null : (create.error ?? update.error);

  return (
    <>
      <PageHeader
        title={isNew ? 'New dashboard' : `Edit ${view.data?.title ?? ''}`}
        actions={
          <>
            {!isNew && (
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => navigate(isNew ? '/dashboards' : `/dashboards/${id}`)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!spec.panels.length || !spec.title.trim()}
              loading={busy}
              onClick={() => void save()}
            >
              Save
            </Button>
          </>
        }
      />
      <PageBody className="grid grid-cols-1 gap-4 xl:grid-cols-[440px_minmax(0,1fr)] xl:items-start">
        <Card className="xl:sticky xl:top-[68px]">
          <DashboardEditor spec={spec} onChange={setDraft} metrics={metrics.data?.metrics} />
          {conflict && (
            <div
              role="alert"
              className="mt-3 flex flex-col gap-2 rounded-[10px] border border-warnbd bg-warndim p-3 text-[12px] text-warn"
            >
              Someone saved this dashboard while you were editing.
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setDraft(null);
                    setConflict(false);
                    void view.refetch();
                  }}
                >
                  Load theirs
                </Button>
                <Button size="sm" variant="danger" onClick={() => void save(true)}>
                  Overwrite with mine
                </Button>
              </div>
            </div>
          )}
          <ErrorNote error={error} className="mt-3" />
        </Card>
        <div className="min-w-0">
          <SectionLabel className="mb-2">Preview</SectionLabel>
          {spec.panels.length ? (
            <ViewGrid spec={spec} data={httpData} links={links} refreshMs={0} />
          ) : (
            <p className="text-[13px] text-t3">Panels show here as you add them.</p>
          )}
        </div>
      </PageBody>
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this dashboard?"
          message="The dashboard and its panels go for everyone."
          action="Delete"
          busy={remove.isPending}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => remove.mutate(id!, { onSuccess: () => navigate('/dashboards') })}
        />
      )}
    </>
  );
}
