import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowUp, Bot, Check, ChevronsRight, Loader2, Maximize2, Plus, Square, Wrench, X } from 'lucide-react';
import { Button, cn, EmptyState, Markdown } from '@clickland/ui';
import { splitMarkers } from '@/lib/markers';
import { toolLabel, useAssistant, type ChatMessage } from './assistant-context';
import { ViewEmbed } from './view-embed';

const SUGGESTIONS = [
  'What is failing right now?',
  'Show me the slowest traces in the last hour',
  'Build a dashboard for the api service',
];

/** The assistant's chat: a side card on desktop (it folds; the page stays visible), a full page on a phone. */
export function AssistantChat({ variant, onFold }: { variant: 'card' | 'page'; onFold?: () => void }) {
  const { messages, streaming, unavailable, send, stop, reset } = useAssistant();
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.text, last?.tools.length]);

  const submit = (text = draft) => {
    if (!text.trim() || streaming) return;
    setDraft('');
    void send(text);
  };

  return (
    <section
      aria-label="Assistant"
      className={cn(
        'flex min-h-0 flex-col',
        variant === 'card' ? 'h-full bg-sf' : 'h-[calc(100dvh-52px-56px)] md:h-[calc(100dvh-52px)]',
      )}
      data-testid={`assistant-${variant}`}
    >
      {variant === 'card' && (
        <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hair px-3">
          <Bot className="size-4 text-t2" strokeWidth={1.7} />
          <h2 className="flex-1 text-[14px] font-semibold text-t1">Assistant</h2>
          <Button size="icon-sm" variant="ghost" aria-label="New chat" title="New chat" onClick={reset}>
            <Plus className="size-4" />
          </Button>
          <Link
            to="/assistant"
            aria-label="Open as a page"
            title="Open as a page"
            className="grid size-7 place-items-center rounded-full text-t2 hover:bg-acdim hover:text-ac"
          >
            <Maximize2 className="size-3.5" />
          </Link>
          {onFold && (
            <Button size="icon-sm" variant="ghost" aria-label="Fold the assistant" title="Fold" onClick={onFold}>
              <ChevronsRight className="size-4" />
            </Button>
          )}
        </header>
      )}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-3 md:px-4">
        {unavailable ? (
          <EmptyState
            icon={<Bot className="size-5" strokeWidth={1.7} />}
            title="Connect the Landflow assistant"
            hint={
              <>
                Clickland’s assistant is a Landflow chat flow, and the API has none connected yet (it answered{' '}
                <code className="font-mono text-[12px]">503 assistant_unavailable</code>). Point the API at a Landflow
                chat flow, then try again.
                <span className="mt-2 block text-[12px] text-t3">{unavailable}</span>
              </>
            }
            action={
              <Button onClick={() => submit(messages.filter((m) => m.role === 'user').at(-1)?.text ?? 'Hello')}>
                Try again
              </Button>
            }
          />
        ) : messages.length === 0 ? (
          <div className="flex flex-col gap-3 py-6">
            <EmptyState
              compact
              icon={<Bot className="size-5" strokeWidth={1.7} />}
              title="Ask about your logs, traces and metrics"
              hint="Answers can include live views you can open or save as dashboards."
            />
            <div className="flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => submit(s)}
                  className="rounded-xl border border-hair px-3 py-2 text-left text-[13px] text-t2 hover:border-bd hover:text-t1"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <Message key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>

      <form
        className="shrink-0 border-t border-hair p-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border border-hair bg-wl p-1.5 focus-within:border-ac">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder="Ask the assistant…"
            aria-label="Message"
            className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] text-t1 outline-none placeholder:text-t3 md:text-[13px]"
          />
          {streaming ? (
            <Button size="icon" variant="outline" aria-label="Stop" onClick={stop}>
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button size="icon" variant="primary" type="submit" aria-label="Send" disabled={!draft.trim()}>
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

function Message({ message }: { message: ChatMessage }) {
  const navigate = useNavigate();
  if (message.role === 'user') {
    return (
      <div className="ml-8 self-end rounded-2xl rounded-br-md bg-acdim px-3 py-2 text-[13px] text-t1 whitespace-pre-wrap">
        {message.text}
      </div>
    );
  }
  const segments = splitMarkers(message.text, !message.done);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="assistant-message">
      {message.tools.length > 0 && <ToolActivity tools={message.tools} />}
      {segments.map((s, i) =>
        s.type === 'view' ? (
          <ViewEmbed key={`${s.id}-${i}`} id={s.id} />
        ) : (
          <Markdown
            key={i}
            text={s.text}
            renderLink={(href, children) =>
              href.startsWith('/') ? (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(href);
                  }}
                  className="text-ac underline decoration-acbd underline-offset-2"
                >
                  {children}
                </a>
              ) : (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-ac underline decoration-acbd underline-offset-2"
                >
                  {children}
                </a>
              )
            }
          />
        ),
      )}
      {!message.done && !message.text && message.tools.every((t) => t.status !== 'running') && (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-t3">
          <Loader2 className="size-3.5 animate-spin" /> Thinking…
        </span>
      )}
      {message.error && (
        <p role="alert" className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">
          {message.error}
        </p>
      )}
    </div>
  );
}

/** Tool calls as one compact line of chips: a spinner while running, then a check or a cross. */
function ToolActivity({ tools }: { tools: ChatMessage['tools'] }) {
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Tool activity" data-testid="tool-activity">
      <Wrench className="size-3 text-t3" />
      {tools.map((t, i) => (
        <span
          key={i}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px]',
            t.status === 'error' ? 'border-rdbd text-rd' : 'border-hair text-t2',
          )}
        >
          {t.status === 'running' ? (
            <Loader2 className="size-3 animate-spin" />
          ) : t.status === 'error' ? (
            <X className="size-3" />
          ) : (
            <Check className="size-3 text-gn" />
          )}
          <span title={t.name}>{toolLabel(t.name)}</span>
        </span>
      ))}
    </div>
  );
}
