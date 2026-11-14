import { Outlet, useLocation } from 'react-router';
import { Bot, Loader2, LogIn } from 'lucide-react';
import { Button, cn } from '@clickland/ui';
import { ApiError } from '@/lib/api';
import { signIn, useMe } from '@/lib/auth';
import { AssistantChat } from '../assistant/chat';
import { AssistantProvider, useAssistant } from '../assistant/assistant-context';
import { BottomBar } from './bottom-bar';
import { Mark } from './mark';
import { Sidebar } from './sidebar';

/**
 * The console. Without a session it shows "Sign in with Landbright" (GET /api/auth/me answered 401); with one, the
 * sidebar (desktop) or bottom bar (phone), the page, and on desktop the assistant as a side card that folds.
 */
export function AppShell() {
  const me = useMe();
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;

  if (me.data) {
    return (
      <AssistantProvider>
        <Frame me={me.data} />
      </AssistantProvider>
    );
  }
  if (unauthenticated) {
    return (
      <Gate
        icon={<LogIn className="size-5" strokeWidth={1.7} />}
        title="Sign in to Clickland"
        hint="Clickland uses your Landbright account."
        action={
          <Button variant="primary" onClick={() => signIn()}>
            Sign in with Landbright
          </Button>
        }
      />
    );
  }
  if (me.isError) {
    return (
      <Gate
        title="Can’t reach the Clickland API"
        hint={
          <>
            The console sends <code className="font-mono text-[12px]">/api</code> to the API on 127.0.0.1:4710. Start it,
            and the infrastructure with <code className="font-mono text-[12px]">pnpm dev:up</code>.
            <span className="mt-1 block text-[12px] text-t3">{me.error.message}</span>
          </>
        }
        action={<Button onClick={() => void me.refetch()}>Try again</Button>}
      />
    );
  }
  return <Gate icon={<Loader2 className="size-5 animate-spin" />} title="Opening Clickland…" />;
}

function Frame({ me }: { me: NonNullable<ReturnType<typeof useMe>['data']> }) {
  const { pathname } = useLocation();
  const assistant = useAssistant();
  const onAssistantPage = pathname.startsWith('/assistant');
  return (
    <div className="flex min-h-dvh">
      <Sidebar me={me} />
      <main className={cn('min-w-0 flex-1 pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-0')}>
        <Outlet />
      </main>
      {!onAssistantPage &&
        (assistant.open ? (
          <aside className="sticky top-0 hidden h-dvh w-[340px] shrink-0 border-l border-hair md:block lg:w-[400px]" data-testid="assistant-side">
            <AssistantChat variant="card" onFold={() => assistant.setOpen(false)} />
          </aside>
        ) : (
          <button
            type="button"
            onClick={() => assistant.setOpen(true)}
            className="fixed bottom-5 right-5 z-30 hidden h-10 items-center gap-2 rounded-full border border-hair bg-sf px-4 text-[13px] font-semibold text-t1 shadow-pop hover:border-bd md:inline-flex"
            data-testid="assistant-unfold"
          >
            <Bot className="size-4" strokeWidth={1.7} />
            Assistant
            {assistant.streaming && <span className="size-1.5 animate-pulse-soft rounded-full bg-ac" />}
          </button>
        ))}
      <BottomBar me={me} />
    </div>
  );
}

function Gate({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg p-6" data-testid="gate">
      <div className="flex max-w-[420px] flex-col items-center gap-2 text-center">
        <Mark size="md" className="mb-2" />
        {icon && <div className="text-t3">{icon}</div>}
        <h1 className="text-[17px] font-semibold text-t1">{title}</h1>
        {hint && <div className="text-[13px] leading-snug text-t2">{hint}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}
