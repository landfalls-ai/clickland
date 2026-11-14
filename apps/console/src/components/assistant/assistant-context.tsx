import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { readEvents } from '@/lib/sse';

export type ToolStatus = 'running' | 'done' | 'error';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: { name: string; status: ToolStatus }[];
  error?: string;
  done: boolean;
}

export interface AssistantState {
  messages: ChatMessage[];
  streaming: boolean;
  /** The API answered 503 assistant_unavailable: no Landflow chat flow is connected. */
  unavailable: string | null;
  /** The side card is open (desktop). */
  open: boolean;
  setOpen: (open: boolean) => void;
  send: (message: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

const Ctx = createContext<AssistantState | null>(null);

const SESSION = 'clickland-assistant-session';
const MESSAGES = 'clickland-assistant-messages';
const OPEN = 'clickland-assistant-open';

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function load<T>(storage: 'local' | 'session', key: string, fallback: T): T {
  try {
    const raw = (storage === 'local' ? localStorage : sessionStorage).getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(storage: 'local' | 'session', key: string, value: unknown) {
  try {
    (storage === 'local' ? localStorage : sessionStorage).setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or private mode: the chat lasts for this page.
  }
}

/** A tool event's status as one of three. */
export function toolStatus(status: string | undefined): ToolStatus {
  const s = (status ?? '').toLowerCase();
  if (/err|fail/.test(s)) return 'error';
  if (/^(start|started|running|call|calling|pending|in_progress)$/.test(s)) return 'running';
  return 'done';
}

/** A tool's name as people read it: `Logs_analyst` → "Logs analyst", `search_logs` → "search logs". */
export function toolLabel(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1).toLowerCase() : name;
}

/** Applies one streamed event to the answer being written. */
export function applyEvent(message: ChatMessage, event: unknown): ChatMessage {
  if (!event || typeof event !== 'object') return message;
  const e = event as { type?: string; delta?: string; name?: string; status?: string; message?: string };
  switch (e.type) {
    case 'text':
      return { ...message, text: message.text + (e.delta ?? '') };
    case 'tool': {
      const status = toolStatus(e.status);
      const tools = [...message.tools];
      const open = tools.findLastIndex((t) => t.name === e.name && t.status === 'running');
      if (status !== 'running' && open >= 0) tools[open] = { name: tools[open]!.name, status };
      else tools.push({ name: e.name ?? 'tool', status });
      return { ...message, tools };
    }
    case 'done':
      return { ...message, done: true, tools: message.tools.map((t) => (t.status === 'running' ? { ...t, status: 'done' } : t)) };
    case 'error':
      return { ...message, done: true, error: e.message ?? 'The assistant failed.' };
    default:
      return message;
  }
}

/**
 * The assistant's chat, held above the routes so it survives navigation: the side card (desktop) and the
 * /assistant page (phone) show the same conversation. Answers stream from POST /api/assistant/chat, which proxies a
 * Landflow chat flow.
 */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const [sessionId, setSessionId] = useState<string>(() => load('session', SESSION, '') || newId());
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    load<ChatMessage[]>('session', MESSAGES, []).map((m) => ({ ...m, done: true })),
  );
  const [streaming, setStreaming] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [open, setOpenState] = useState<boolean>(() => load('local', OPEN, false));
  const abort = useRef<AbortController | null>(null);

  useEffect(() => save('session', SESSION, sessionId), [sessionId]);
  useEffect(() => {
    if (!streaming) save('session', MESSAGES, messages.slice(-60));
  }, [messages, streaming]);

  const setOpen = useCallback((value: boolean) => {
    setOpenState(value);
    save('local', OPEN, value);
  }, []);

  const update = (id: string, fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || abort.current) return;
      const answerId = newId();
      const questionId = newId();
      setMessages((prev) => [
        ...prev,
        { id: questionId, role: 'user', text: message, tools: [], done: true },
        { id: answerId, role: 'assistant', text: '', tools: [], done: false },
      ]);
      const controller = new AbortController();
      abort.current = controller;
      setStreaming(true);
      try {
        const response = await fetch('/api/assistant/chat', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ sessionId, message }),
          signal: controller.signal,
        });
        if (!response.ok) {
          let code = '';
          let msg = `The assistant answered ${response.status}.`;
          try {
            const body = (await response.json()) as { error?: { code?: string; message?: string } };
            code = body.error?.code ?? '';
            msg = body.error?.message ?? msg;
          } catch {
            // Not JSON.
          }
          if (response.status === 503 && (code === 'assistant_unavailable' || !code)) {
            setUnavailable(msg);
            // Nothing answered: the question goes too, so a reload does not show it hanging.
            setMessages((prev) => prev.filter((m) => m.id !== answerId && m.id !== questionId));
            return;
          }
          throw new ApiError(response.status, code || 'internal', msg);
        }
        setUnavailable(null);
        if (!response.body) throw new Error('The assistant sent no answer.');
        for await (const event of readEvents(response.body, controller.signal)) update(answerId, (m) => applyEvent(m, event));
        update(answerId, (m) => ({ ...m, done: true }));
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          update(answerId, (m) => ({ ...m, done: true, error: m.text ? undefined : 'Stopped.' }));
        } else {
          update(answerId, (m) => ({ ...m, done: true, error: e instanceof Error ? e.message : String(e) }));
        }
      } finally {
        abort.current = null;
        setStreaming(false);
      }
    },
    [sessionId],
  );

  const stop = useCallback(() => abort.current?.abort(), []);
  const reset = useCallback(() => {
    abort.current?.abort();
    setMessages([]);
    setSessionId(newId());
  }, []);

  const value = useMemo(
    () => ({ messages, streaming, unavailable, open, setOpen, send, stop, reset }),
    [messages, streaming, unavailable, open, setOpen, send, stop, reset],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistant(): AssistantState {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAssistant needs <AssistantProvider>');
  return value;
}
