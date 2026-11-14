import { Outlet, useLocation } from 'react-router';
import { Bot, Loader2 } from 'lucide-react';
import { Button, cn } from '@clickland/ui';
import { ApiError } from '@/lib/api';
import { SIGN_IN_ERRORS, signIn, useMe } from '@/lib/auth';
import { AssistantChat } from '../assistant/chat';
import { AssistantProvider, useAssistant } from '../assistant/assistant-context';
import { BottomBar } from './bottom-bar';
import { Mark } from './mark';
import { Sidebar } from './sidebar';

/**
 * The console. Without a session it is the sign-in page, "Sign in with Landbright" (GET /api/auth/me answered 401),
 * with the reason a sign-in came back without one; with a session, the sidebar (desktop) or bottom bar (phone), the
 * page, and on desktop the assistant as a side card that folds.
 */
export function AppShell() {
  const me = useMe();
  const { search } = useLocation();
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;

  if (me.data) {
    return (
      <AssistantProvider>
        <Frame me={me.data} />
      </AssistantProvider>
    );
  }
  if (unauthenticated) {
    const details = (me.error as ApiError).details as
      { signIn?: string; problem?: string; reason?: string } | undefined;
    const error = details?.reason ?? new URLSearchParams(search).get('signin_error');
    const off = details?.signIn === 'unavailable';
    return (
      <Gate
        title={error === 'no_role' ? 'No access to Clickland yet' : 'Sign in to Clickland'}
        hint="Clickland uses your Landbright account. Your Landbright groups decide what you can see and do."
        message={
          off
            ? `Sign-in with Landbright isn’t set up on this machine yet: ${details?.problem ?? ''}`
            : error
              ? (SIGN_IN_ERRORS[error] ?? SIGN_IN_ERRORS.failed)
              : undefined
        }
        action={
          <Button
            variant="primary"
            disabled={off}
            onClick={() => signIn()}
            className="h-10 w-full max-w-[320px] justify-center text-[14px]"
            data-testid="sign-in"
          >
            {error === 'no_role' ? 'Sign in as someone else' : 'Sign in with Landbright'}
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
            The console sends <code className="font-mono text-[12px]">/api</code> to the API on 127.0.0.1:4710. Start
            it, and the infrastructure with <code className="font-mono text-[12px]">pnpm dev:up</code>.
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
          <aside
            className="sticky top-0 hidden h-dvh w-[340px] shrink-0 border-l border-hair md:block lg:w-[400px]"
            data-testid="assistant-side"
          >
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
  message,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
  message?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg p-6" data-testid="gate">
      <div className="flex w-full max-w-[400px] flex-col items-center gap-2.5 text-center">
        <Mark size="md" className="mb-1" />
        {icon && <div className="text-t3">{icon}</div>}
        <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-t1">{title}</h1>
        {hint && <div className="text-[13px] leading-snug text-t2">{hint}</div>}
        {message && (
          <div
            className="mt-1 w-full rounded-[10px] border border-hair bg-sf px-3 py-2.5 text-left text-[13px] text-t1"
            role="alert"
          >
            {message}
          </div>
        )}
        {action && <div className="mt-3 flex w-full justify-center">{action}</div>}
        <p className="mt-4 text-[12px] text-t3">Logs, traces and metrics for the land family.</p>
      </div>
    </div>
  );
}
