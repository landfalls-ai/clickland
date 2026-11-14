import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { AgentAlertTemplate } from '@clickland/contracts';
import { ErrorNote, Skeleton } from '@clickland/ui';
import { Dialog } from '@/components/ui/dialog';
import { agentApi, useAlertTemplates } from '@/lib/agents';
import { useWrite } from '@/lib/queries';

const KINDS: Array<{ kind: AgentAlertTemplate['kind']; label: string }> = [
  { kind: 'cost', label: 'Cost' },
  { kind: 'errors', label: 'Errors' },
  { kind: 'quality', label: 'Quality' },
];

/** "From a template": the AI agent alert templates by kind; choosing one installs it and opens the new alert. */
export function AlertTemplatesDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const templates = useAlertTemplates();
  const install = useWrite(agentApi.installTemplate, ['alerts']);
  return (
    <Dialog title="New alert from a template" subtitle="AI agents: cost, errors and quality" onClose={onClose}>
      {templates.isLoading ? (
        <Skeleton lines={6} />
      ) : templates.error ? (
        <ErrorNote error={templates.error} />
      ) : (
        <div className="flex flex-col gap-4" data-testid="alert-templates">
          {KINDS.map(({ kind, label }) => {
            const list = (templates.data ?? []).filter((t) => t.kind === kind);
            if (!list.length) return null;
            return (
              <section key={kind} className="flex flex-col gap-1.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{label}</h3>
                {list.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    disabled={install.isPending}
                    onClick={() =>
                      install.mutate(t.key, {
                        onSuccess: (alert) => {
                          toast.success(`“${alert.name}” added`);
                          navigate(`/alerts/${alert.id}`);
                        },
                        onError: (e) => toast.error(e.message),
                      })
                    }
                    className="flex flex-col gap-0.5 rounded-xl border border-hair px-3 py-2.5 text-left transition-colors hover:border-ac disabled:opacity-60"
                  >
                    <span className="text-[13px] font-semibold text-t1">{t.title}</span>
                    <span className="text-[12px] leading-snug text-t2">{t.description}</span>
                  </button>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
