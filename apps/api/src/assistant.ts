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
 * forwards `{ sessionId, message, user }` to the flow's chat URL and turns the answer into the panel's events. Landflow
 * answers with JSON (`{ output | text | answer, runId? }`) or with server-sent events; both are handled.
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
  if (config.assistantSecret) headers[config.assistantAuthHeader ?? 'authorization'] = config.assistantSecret;
  let res: Response;
  try {
    res = await fetchImpl(config.assistantUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: input.sessionId,
        chatInput: input.message,
        message: input.message,
        user: input.user,
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
  yield { type: 'done', runId: typeof body.runId === 'string' ? body.runId : undefined };
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

/** Landflow's stream, mapped to the panel's events: text deltas and tool activity pass through, the rest is dropped. */
async function* readEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<AssistantEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
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
        yield { type: 'text', delta: data };
        continue;
      }
      const kind = event.type;
      if (
        (kind === 'text' || kind === 'delta' || kind === 'chunk' || kind === 'item') &&
        (typeof event.delta === 'string' || typeof event.content === 'string')
      )
        yield { type: 'text', delta: String(event.delta ?? event.content) };
      else if (kind === 'tool')
        yield {
          type: 'tool',
          name: String(event.name ?? 'tool'),
          status: (event.status as 'started' | 'done' | 'failed') ?? 'started',
        };
      else if (kind === 'error') yield { type: 'error', message: String(event.message ?? 'The assistant failed') };
      else if (kind === 'done' || kind === 'end') {
        const text = pickText(event);
        if (text) yield { type: 'text', delta: text };
        done = true;
        yield { type: 'done', runId: typeof event.runId === 'string' ? event.runId : undefined };
      }
    }
  }
  if (!done) yield { type: 'done' };
}
