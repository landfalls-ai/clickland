import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/**
 * The console as an MCP Apps host: one MCP client over Streamable HTTP to the API's /api/mcp, carrying the
 * browser's session cookie (same origin). It reads the `ui://clickland/view` app, gets views for the assistant's
 * markers, and runs the tool calls the app makes.
 */

export const VIEW_RESOURCE = 'ui://clickland/view';

export interface ToolResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [k: string]: unknown;
}

let client: Promise<Client> | null = null;
let html: Promise<string> | null = null;

function connect(): Promise<Client> {
  client ??= (async () => {
    const c = new Client(
      { name: 'clickland-console', version: '0.1.0' },
      {
        capabilities: {
          extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
        } as never,
      },
    );
    await c.connect(
      new StreamableHTTPClientTransport(new URL('/api/mcp', window.location.origin), {
        requestInit: { credentials: 'same-origin' },
      }),
    );
    return c;
  })().catch((e: unknown) => {
    client = null;
    throw e;
  });
  return client;
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const c = await connect();
  return (await c.callTool({ name, arguments: args })) as ToolResult;
}

/** The app's HTML (read once per page load). */
export function viewHtml(): Promise<string> {
  html ??= (async () => {
    const c = await connect();
    const result = await c.readResource({ uri: VIEW_RESOURCE });
    const content = result.contents[0] as { text?: string; blob?: string } | undefined;
    if (content?.text) return content.text;
    if (content?.blob) return new TextDecoder().decode(Uint8Array.from(atob(content.blob), (c) => c.charCodeAt(0)));
    throw new Error(`${VIEW_RESOURCE} came back empty.`);
  })().catch((e: unknown) => {
    html = null;
    throw e;
  });
  return html;
}

/**
 * Where the sandbox proxy lives: the same server under the other loopback name, so its origin differs from the
 * console's (an MCP App must never share the host's origin). VITE_CLICKLAND_SANDBOX_URL overrides it.
 */
export function sandboxUrl(
  location: Pick<Location, 'protocol' | 'hostname' | 'port' | 'origin'> = window.location,
): URL {
  const override = import.meta.env.VITE_CLICKLAND_SANDBOX_URL as string | undefined;
  if (override) return new URL(override);
  const other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  return new URL(`${location.protocol}//${other}${location.port ? `:${location.port}` : ''}/sandbox.html`);
}
