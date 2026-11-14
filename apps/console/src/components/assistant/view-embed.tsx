import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AppRenderer } from '@mcp-ui/client';
import { Check, ExternalLink, LayoutDashboard } from 'lucide-react';
import { Button, ErrorNote, Skeleton } from '@clickland/ui';
import { useCan } from '@/lib/auth';
import { callTool, sandboxUrl, viewHtml, type ToolResult } from '@/lib/mcp-host';
import { api, useWrite } from '@/lib/queries';
import { effectiveTheme } from '../shell/theme-toggle';

/** Sends a link the app opens through the router when it points into the console, else to a new tab. */
export function openFromApp(url: string, navigate: (to: string) => void) {
  try {
    const target = new URL(url, window.location.origin);
    const local = ['localhost', '127.0.0.1'].includes(target.hostname) && target.port === window.location.port;
    if (target.origin === window.location.origin || local) return navigate(`${target.pathname}${target.search}${target.hash}`);
    if (/^https?:$/.test(target.protocol)) window.open(target.href, '_blank', 'noopener,noreferrer');
  } catch {
    // Not a URL: ignore.
  }
}

/**
 * A `[[clickland:view:vw_…]]` marker drawn as the `ui://clickland/view` MCP App: the console is the MCP Apps host.
 * It reads the app over MCP, passes it the `get_view` result, and runs the app's tool calls through the same client.
 */
export function ViewEmbed({ id }: { id: string }) {
  const navigate = useNavigate();
  const canEdit = useCan('edit');
  const [frameError, setFrameError] = useState<string | null>(null);
  const loaded = useQuery({
    queryKey: ['mcp-view', id],
    queryFn: async () => {
      const [html, result] = await Promise.all([viewHtml(), callTool('get_view', { id })]);
      if (result.isError) throw new Error(result.content?.find((c) => c.type === 'text')?.text ?? 'get_view failed.');
      return { html, result };
    },
    staleTime: Infinity,
    retry: 1,
  });
  const pinnedAtLoad = loaded.data?.result.structuredContent?.pinned === true;
  const save = useWrite(api.updateView, ['views']);
  const pinned = pinnedAtLoad || save.isSuccess;

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-hair bg-sf" data-testid="view-embed">
      <div className="min-h-[120px] p-1">
        {loaded.isError ? (
          <ErrorNote error={loaded.error} className="m-2" />
        ) : !loaded.data ? (
          <Skeleton lines={4} className="p-3" />
        ) : (
          <AppRenderer
            toolName="get_view"
            sandbox={{ url: sandboxUrl() }}
            html={loaded.data.html}
            toolInput={{ id }}
            toolResult={loaded.data.result as never}
            hostInfo={{ name: 'clickland-console', version: '0.1.0' }}
            hostContext={{
              theme: effectiveTheme(),
              platform: 'web',
              displayMode: 'inline',
              availableDisplayModes: ['inline'],
              locale: navigator.language,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }}
            hostCapabilities={{ serverTools: {}, openLinks: {}, logging: {} }}
            onCallTool={async (params) => (await callTool(params.name, params.arguments ?? {})) as never}
            onOpenLink={async ({ url }) => {
              openFromApp(url, navigate);
              return {};
            }}
            onError={(e) => setFrameError(e.message)}
          />
        )}
        {frameError && <ErrorNote error={frameError} className="m-2" />}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hair px-2.5 py-2">
        <span className="mr-auto truncate font-mono text-[11px] text-t3">{id}</span>
        <Button size="sm" variant="ghost" onClick={() => navigate(pinned ? `/dashboards/${id}` : `/views/${id}`)}>
          <ExternalLink className="size-3.5" /> Open
        </Button>
        {canEdit &&
          (pinned ? (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-gnbd bg-gndim px-3 text-[12px] font-semibold text-gn">
              <Check className="size-3.5" /> Dashboard
            </span>
          ) : (
            <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate({ id, pinned: true })}>
              <LayoutDashboard className="size-3.5" /> Save as dashboard
            </Button>
          ))}
      </div>
      {save.error && <ErrorNote error={save.error} className="m-2" />}
    </div>
  );
}

export type { ToolResult };
