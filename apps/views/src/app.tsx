import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@modelcontextprotocol/ext-apps/react';
import type { Signal } from '@clickland/contracts';
import type { PanelLinks } from '@clickland/ui';
import { applyHostContext } from './host-theme';
import { mcpDataSource } from './mcp-data';
import { structured, viewFromToolResult, type LoadedView, type ToolCall } from './tool-result';
import { ViewScreen, type SaveState } from './view-screen';

/**
 * The `ui://clickland/view` MCP App. The host sends the tool's input and result; the app draws the view and each
 * panel fetches its own data through the host (`callServerTool`), so a view stays live in Claude, in Clickland's
 * console and in any other MCP Apps host.
 */
export function ViewApp() {
  const [view, setView] = useState<LoadedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>('idle');
  const input = useRef<Record<string, unknown>>({});

  const { app, error: connectError } = useApp({
    appInfo: { name: 'clickland-view', version: '0.1.0' },
    capabilities: {},
    onAppCreated: (created) => {
      created.addEventListener('toolinput', (params) => {
        input.current = params.arguments ?? {};
      });
      created.addEventListener('toolresult', (result) => {
        try {
          setView(
            viewFromToolResult({
              name: created.getHostContext()?.toolInfo?.tool.name,
              arguments: input.current,
              result: result as ToolCall['result'],
            }),
          );
          setError(null);
          setSave('idle');
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
      created.addEventListener('toolcancelled', (params) => setError(params.reason ?? 'The tool call was cancelled.'));
      created.addEventListener('hostcontextchanged', (ctx) => applyHostContext(ctx));
    },
  });

  useEffect(() => {
    if (app) applyHostContext(app.getHostContext());
  }, [app]);

  const data = useMemo(
    () =>
      app
        ? mcpDataSource(
            async (name, args) => (await app.callServerTool({ name, arguments: args })) as ToolCall['result'],
          )
        : null,
    [app],
  );

  const consoleOrigin = useMemo(() => {
    try {
      return view?.url ? new URL(view.url).origin : null;
    } catch {
      return null;
    }
  }, [view?.url]);

  const open = useCallback(
    (url: string) => {
      void app?.openLink({ url });
    },
    [app],
  );

  const links: PanelLinks | undefined = consoleOrigin
    ? {
        openTrace: (traceId) => open(`${consoleOrigin}/traces/${traceId}`),
        openSearch: ({ signal, query }: { signal: Signal; query: string }) =>
          open(`${consoleOrigin}/search?${new URLSearchParams({ signal, query })}`),
        openService: (name) => open(`${consoleOrigin}/services/${encodeURIComponent(name)}`),
        openAgent: (id) => open(`${consoleOrigin}/agents/${encodeURIComponent(id)}`),
        openRun: (traceId) => open(`${consoleOrigin}/agents/runs/${traceId}`),
      }
    : undefined;

  const onSave = async () => {
    if (!app || !view?.id) return;
    setSave('saving');
    try {
      const result = (await app.callServerTool({
        name: 'update_view',
        arguments: { id: view.id, pinned: true },
      })) as ToolCall['result'];
      if (result.isError) throw new Error(result.content?.find((c) => c.type === 'text')?.text ?? 'Saving failed.');
      const body = structured(result);
      const url = typeof body?.url === 'string' ? body.url : view.url;
      setView({ ...view, pinned: true, url });
      setSave('saved');
    } catch (e) {
      setSave({ error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <ViewScreen
      view={view}
      data={data}
      error={error ?? (connectError ? `Couldn’t connect to the host: ${connectError.message}` : null)}
      save={save}
      onSave={app ? () => void onSave() : undefined}
      onOpen={view?.url ? () => open(view.url!) : undefined}
      links={links}
    />
  );
}
