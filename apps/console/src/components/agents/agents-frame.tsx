import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { cn, ErrorNote, Segmented, Skeleton } from '@clickland/ui';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { PERIODS, type Period, useAgentPeriod } from '@/lib/agents';
import { useCan } from '@/lib/auth';

const TABS = [
  { href: '/agents', label: 'Value', end: true },
  { href: '/agents/list', label: 'Agents' },
  { href: '/agents/safety', label: 'Safety' },
  { href: '/agents/settings', label: 'Settings', admin: true },
];

export function PeriodPicker() {
  const { period, setPeriod } = useAgentPeriod();
  return (
    <Segmented<Period>
      label="Period"
      value={period}
      onChange={setPeriod}
      options={PERIODS.map((p) => ({ value: p.value, label: p.value, title: p.label }))}
    />
  );
}

/** The Agents pages' frame: the title and period picker, the four tabs (Settings for admins), then the page. */
export function AgentsFrame({
  children,
  back,
  title = 'Agents',
  meta,
  period = true,
  tabs = true,
}: {
  children: ReactNode;
  /** A back link (the agent and run pages) instead of the tabs. */
  back?: { to: string; label: string };
  title?: ReactNode;
  meta?: ReactNode;
  period?: boolean;
  tabs?: boolean;
}) {
  const { carry } = useAgentPeriod();
  const admin = useCan('admin');
  return (
    <>
      <PageHeader
        title={
          back ? (
            <span className="flex min-w-0 items-center gap-2">
              <Link to={back.to} aria-label={back.label} title={back.label} className="text-t3 hover:text-t1">
                <ArrowLeft className="size-4" />
              </Link>
              <span className="min-w-0 truncate">{title}</span>
            </span>
          ) : (
            title
          )
        }
        meta={meta}
        actions={period ? <PeriodPicker /> : undefined}
      />
      {tabs && !back && (
        <nav
          aria-label="Agents"
          className="flex gap-1 overflow-x-auto border-b border-hair px-4 pt-2 md:px-6"
          data-testid="agents-tabs"
        >
          {TABS.filter((t) => !t.admin || admin).map((t) => (
            <NavLink
              key={t.href}
              to={`${t.href}${carry}`}
              end={t.end}
              className={({ isActive }) =>
                cn(
                  '-mb-px whitespace-nowrap border-b-2 px-3 pb-2 pt-1 text-[13px] transition-colors',
                  isActive ? 'border-ac font-semibold text-t1' : 'border-transparent text-t2 hover:text-t1',
                )
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
      )}
      <PageBody className="flex flex-col gap-4">{children}</PageBody>
    </>
  );
}

/** A section: a heading and its content. */
export function Section({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{title}</h2>
        {aside && <div className="ml-auto text-[12px] text-t3">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** "The figures cover the newest spans only", when the API read a capped number of spans. */
export function TruncatedBanner({ truncated }: { truncated?: boolean }) {
  if (!truncated) return null;
  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-[10px] border border-warnbd bg-warndim px-3 py-2 text-[12px] text-warn"
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      The period held more spans than one question reads: the figures cover the newest spans only.
    </p>
  );
}

/** Loading, error and data, as every page needs. */
export function Loaded<T>({
  query,
  lines = 6,
  children,
}: {
  query: { data: T | undefined; error: Error | null; isLoading: boolean };
  lines?: number;
  children: (data: T) => ReactNode;
}) {
  if (query.isLoading) return <Skeleton lines={lines} />;
  if (query.error && query.data === undefined) return <ErrorNote error={query.error} />;
  if (query.data === undefined) return null;
  return <>{children(query.data)}</>;
}

export const DOCS_CLAUDE_CODE =
  'https://github.com/landfalls-ai/clickland/blob/main/docs/agent-value.md#claude-codes-telemetry';
