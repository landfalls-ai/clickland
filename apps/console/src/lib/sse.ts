/** Reads a server-sent-events body: yields each event's `data` parsed as JSON. */
export async function* readEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
        const event = parseEvent(raw);
        if (event !== undefined) yield event;
      }
    }
    const event = parseEvent(buffer);
    if (event !== undefined) yield event;
  } finally {
    reader.releaseLock();
  }
}

export function parseEvent(raw: string): unknown {
  const data = raw
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return { type: 'text', delta: data };
  }
}
