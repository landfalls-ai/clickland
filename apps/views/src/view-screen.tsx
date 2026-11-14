import { Check, ExternalLink, LayoutDashboard, Loader2 } from 'lucide-react';
import { Button, ErrorNote, Skeleton, ViewGrid, type DataSource, type PanelLinks } from '@clickland/ui';
import type { LoadedView } from './tool-result';

export type SaveState = 'idle' | 'saving' | 'saved' | { error: string };

/** The app's screen: the view's grid, with Open and Save as dashboard when the view has an id. */
export function ViewScreen({
  view,
  data,
  error,
  save,
  onSave,
  onOpen,
  links,
}: {
  view: LoadedView | null;
  data: DataSource | null;
  error?: string | null;
  save: SaveState;
  onSave?: () => void;
  onOpen?: () => void;
  links?: PanelLinks;
}) {
  if (error) return <ErrorNote error={error} className="m-1" />;
  if (!view || !data)
    return (
      <div className="flex flex-col gap-3 p-1" data-testid="view-loading">
        <div className="flex items-center gap-2 text-[12px] text-t3">
          <Loader2 className="size-3.5 animate-spin" /> Loading the view…
        </div>
        <Skeleton lines={4} />
      </div>
    );
  const pinned = view.pinned || save === 'saved';
  const actions = (
    <>
      {onOpen && (
        <Button size="sm" onClick={onOpen}>
          <ExternalLink className="size-3.5" /> Open
        </Button>
      )}
      {view.id &&
        (pinned ? (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-gnbd bg-gndim px-3 text-[12px] font-semibold text-gn">
            <Check className="size-3.5" /> Dashboard
          </span>
        ) : (
          onSave && (
            <Button size="sm" variant="primary" onClick={onSave} loading={save === 'saving'}>
              <LayoutDashboard className="size-3.5" /> Save as dashboard
            </Button>
          )
        ))}
    </>
  );
  return (
    <div className="flex flex-col gap-2 p-1">
      <ViewGrid spec={view.spec} data={data} links={links} actions={actions} />
      {typeof save === 'object' && <ErrorNote error={save.error} />}
    </div>
  );
}
