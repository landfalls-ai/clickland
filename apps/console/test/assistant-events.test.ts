import { describe, expect, it } from 'vitest';
import { applyEvent, toolLabel, toolStatus, type ChatMessage } from '@/components/assistant/assistant-context';
import { parseEvent } from '@/lib/sse';

const empty: ChatMessage = { id: 'a', role: 'assistant', text: '', tools: [], done: false };

describe('assistant stream events', () => {
  it('appends text deltas', () => {
    const m = [{ type: 'text', delta: 'Hel' }, { type: 'text', delta: 'lo' }].reduce(applyEvent, empty);
    expect(m.text).toBe('Hello');
  });

  it('tracks a tool from started to done or failed', () => {
    let m = applyEvent(empty, { type: 'tool', name: 'Logs_analyst', status: 'started' });
    m = applyEvent(m, { type: 'tool', name: 'Traces_analyst', status: 'started' });
    expect(m.tools).toEqual([
      { name: 'Logs_analyst', status: 'running' },
      { name: 'Traces_analyst', status: 'running' },
    ]);
    m = applyEvent(m, { type: 'tool', name: 'Logs_analyst', status: 'done' });
    m = applyEvent(m, { type: 'tool', name: 'Traces_analyst', status: 'failed' });
    expect(m.tools).toEqual([
      { name: 'Logs_analyst', status: 'done' },
      { name: 'Traces_analyst', status: 'error' },
    ]);
  });

  it('closes running tools when the answer is done, and records errors', () => {
    let m = applyEvent(empty, { type: 'tool', name: 'Metrics_analyst', status: 'started' });
    m = applyEvent(m, { type: 'done' });
    expect(m.done).toBe(true);
    expect(m.tools[0]!.status).toBe('done');
    expect(applyEvent(empty, { type: 'error', message: 'boom' })).toMatchObject({ done: true, error: 'boom' });
  });

  it('reads statuses and names as people do', () => {
    expect(toolStatus('started')).toBe('running');
    expect(toolStatus('done')).toBe('done');
    expect(toolStatus('failed')).toBe('error');
    expect(toolLabel('Logs_analyst')).toBe('Logs analyst');
    expect(toolLabel('search_logs')).toBe('Search logs');
    expect(toolLabel('queryMetric')).toBe('Query metric');
  });

  it('parses one SSE event block', () => {
    expect(parseEvent('data: {"type":"text","delta":"hi"}')).toEqual({ type: 'text', delta: 'hi' });
  });
});
