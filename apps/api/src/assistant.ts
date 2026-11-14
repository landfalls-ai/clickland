import type { Config } from './config.js';
import { ApiError } from './errors.js';

/** One server-sent event of the Assistant panel's stream. */
export type AssistantEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; status: 'started' | 'done' | 'failed' }
  | { type: 'done'; runId?: string }
  | { type: 'error'; message: string };

/**
 * The Assistant panel talks to Landflow: the observability assistant is a Landflow flow with a chat trigger. Clickland
 * forwards `{ sessionId, message }` (the session id prefixed with the person) to the flow's chat URL,
 * `POST {LANDFLOW}/chat/clickland-assistant`, and turns the answer into the panel's events: server-sent events when the
 * trigger streams, else JSON `{ output, executionId }`.
 */
export async function* askAssistant(
  config: Config,
  input: { sessionId: string; message: string; user: string },
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): AsyncGenerator<AssistantEvent> {
  if (!config.assistantUrl)
    throw new ApiError('assistant_unavailable', 'The Landflow assistant is not connected: set CLICKLAND_ASSISTANT_URL');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
  };
  // Landflow's public chat takes Basic Auth (CLICKLAND_ASSISTANT_BASIC_AUTH=user:password); any other header also works.
  if (config.assistantBasicAuth)
    headers.authorization = `Basic ${Buffer.from(config.assistantBasicAuth).toString('base64')}`;
  if (config.assistantSecret) headers[config.assistantAuthHeader ?? 'authorization'] = config.assistantSecret;
  let res: Response;
  try {
    res = await fetchImpl(config.assistantUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: landflowSessionId(input.user, input.sessionId),
        message: input.message,
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    });
  } catch (error) {
    throw new ApiError(
      'assistant_unavailable',
      `Landflow did not answer: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new ApiError('assistant_unavailable', `Landflow answered ${res.status}${text ? `: ${text}` : ''}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream') && res.body) {
    yield* readEvents(res.body);
    return;
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const text = pickText(body);
  if (text) yield { type: 'text', delta: text };
  const runId = body.executionId ?? body.runId;
  yield { type: 'done', runId: typeof runId === 'string' ? runId : undefined };
}

export function pickText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) return pickText(body[0]);
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const key of ['output', 'text', 'answer', 'response', 'message', 'content']) {
      if (typeof b[key] === 'string') return b[key];
      if (b[key] && typeof b[key] === 'object') {
        const inner = pickText(b[key]);
        if (inner) return inner;
      }
    }
  }
  return '';
}

/**
 * Landflow's chat stream (docs/features/clickland.md in Landflow, "The assistant chat contract"), mapped to the panel's
 * events. `item` chunks are text deltas; `begin`/`end` bracket each node and are dropped; `tool` carries
 * `{ tool: { name, status: started | finished | failed | approval } }` (the analysts show up as tools); the last chunk is
 * `{ type: 'done', executionId, status, output?, error? }`, whose `output` repeats the answer, so it is used only when
 * nothing streamed.
 */
async function* readEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<AssistantEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  let streamed = false;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        streamed = true;
        yield { type: 'text', delta: data };
        continue;
      }
      const kind = event.type;
      const content =
        typeof event.delta === 'string' ? event.delta : typeof event.content === 'string' ? event.content : null;
      if ((kind === 'item' || kind === 'text' || kind === 'delta') && content) {
        streamed = true;
        yield { type: 'text', delta: content };
      } else if (kind === 'tool') {
        const tool = (event.tool ?? event) as { name?: unknown; status?: unknown };
        const status =
          tool.status === 'finished' || tool.status === 'done'
            ? 'done'
            : tool.status === 'failed'
              ? 'failed'
              : 'started';
        yield { type: 'tool', name: String(tool.name ?? 'tool'), status };
      } else if (kind === 'error') {
        yield { type: 'error', message: content ?? errorMessage(event.error) ?? 'The assistant failed' };
      } else if (kind === 'done') {
        const error = errorMessage(event.error);
        if (error) yield { type: 'error', message: error };
        else if (!streamed && typeof event.output === 'string' && event.output)
          yield { type: 'text', delta: event.output };
        done = true;
        const runId = event.executionId ?? event.runId;
        yield { type: 'done', runId: typeof runId === 'string' ? runId : undefined };
      }
    }
  }
  if (!done) yield { type: 'done' };
}

const errorMessage = (error: unknown): string | null =>
  typeof error === 'string'
    ? error
    : error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : null;

/** Landflow chat session ids are `[\w.:-]{1,128}`; each person gets their own, so one can't read another's history. */
export const landflowSessionId = (user: string, sessionId: string) =>
  `${user}:${sessionId}`.replace(/[^\w.:-]/g, '_').slice(0, 128);
