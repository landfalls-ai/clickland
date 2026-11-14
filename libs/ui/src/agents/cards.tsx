/** Cards for AI agents and their value, shared by the console's Agents pages and the view app's panels. */
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ValueAgentRow, ValueFigures, ValueReportResponse } from '@clickland/contracts';
import { cn } from '../cn';
import { Badge, Chip } from '../primitives/badge';
import { Card } from '../primitives/layout';
import {
  familyLabel,
  formatMoney,
  formatOutcomes,
  formatRoi,
  formatRunDuration,
  formatSuccess,
  formatTokens,
} from './format';

/** "How": a disclosure with the arithmetic string exactly as the API wrote it. */
export function How({ text, label = 'How', className }: { text: string; label?: string; className?: string }) {
  if (!text) return null;
  return (
    <details className={cn('group text-[12px]', className)} onClick={(e) => e.stopPropagation()}>
      <summary className="cursor-pointer select-none list-none text-ac hover:underline [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-1">
          <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
          {label}
        </span>
      </summary>
      <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-sf2 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-t2">
        {text}
      </p>
    </details>
  );
}

export function FamilyBadge({ family }: { family: string }) {
  return <Badge tone={family === 'genai' ? 'neutral' : 'accent'}>{familyLabel(family)}</Badge>;
}

/** A label and a value, small. */
export function Figure({
  label,
  value,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: 'danger' | 'success';
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <span className="truncate text-[11px] text-t3">{label}</span>
      <span
        className={cn(
          'truncate font-mono text-[14px] font-semibold tabular-nums text-t1',
          tone === 'danger' && 'text-rd',
          tone === 'success' && 'text-gn',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** What an agent card needs: the full `AgentSummary`, or the shorter rows of the `list_agents` tool. */
export interface AgentCardData {
  id: string;
  name: string;
  service: string;
  family: string;
  runs: number;
  runUnit: string;
  successRate: number | null;
  p50Ms?: number;
  p95Ms: number;
  latencyOf?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  stepErrors: number;
  rateLimits: number;
  retries: number;
  loops: number;
  unpricedModels?: string[];
}

const plural = (n: number, unit: string) => `${n.toLocaleString('en-US')} ${unit}${n === 1 ? '' : 's'}`;

/** One agent: name, family, service; runs, success, latency, tokens, cost; chips for what went wrong. */
export function AgentCard({ agent, onOpen }: { agent: AgentCardData; onOpen?: (id: string) => void }) {
  const chips: Array<[string, string, number]> = [
    ['error', 'errors', agent.stepErrors],
    ['rate limit', 'rate limits', agent.rateLimits],
    ['retry', 'retries', agent.retries],
    ['loop', 'loops', agent.loops],
    ['unpriced model', 'unpriced models', agent.unpricedModels?.length ?? 0],
  ];
  const latency = agent.latencyOf === 'model call' ? 'per model call' : 'per run';
  const body = (
    <Card
      className={cn('flex h-full flex-col gap-2.5', onOpen && 'transition-colors hover:border-bd')}
      testId="agent-card"
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-t1" title={agent.name}>
            {agent.name}
          </p>
          <p className="truncate font-mono text-[11px] text-t3" title={agent.service}>
            {agent.service}
          </p>
        </div>
        <FamilyBadge family={agent.family} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Figure
          label={`${agent.runUnit[0]?.toUpperCase() ?? ''}${agent.runUnit.slice(1)}s`}
          value={formatTokens(agent.runs)}
        />
        <Figure
          label="Success"
          value={formatSuccess(agent.successRate)}
          tone={agent.successRate !== null && agent.successRate < 0.9 ? 'danger' : undefined}
        />
        <Figure label="Cost" value={formatMoney(agent.costUsd, 'USD', { cost: true })} />
        <Figure label={`p50 ${latency}`} value={agent.p50Ms === undefined ? '–' : formatRunDuration(agent.p50Ms)} />
        <Figure label={`p95 ${latency}`} value={formatRunDuration(agent.p95Ms)} />
        <Figure
          label="Tokens in / out"
          value={`${formatTokens(agent.inputTokens)} / ${formatTokens(agent.outputTokens)}`}
        />
      </div>
      {chips.some(([, , n]) => n > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {chips
            .filter(([, , n]) => n > 0)
            .map(([one, many, n]) => (
              <Chip key={many} tone={many === 'retries' ? 'warning' : 'danger'}>
                {n.toLocaleString('en-US')} {n === 1 ? one : many}
              </Chip>
            ))}
        </div>
      )}
    </Card>
  );
  if (!onOpen) return body;
  return (
    <button type="button" className="block h-full w-full text-left" onClick={() => onOpen(agent.id)}>
      {body}
    </button>
  );
}

/** Cards in one column, two or three as the container widens. */
export function CardGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="@container">
      <div className={cn('grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3', className)}>{children}</div>
    </div>
  );
}

export function AgentCards({ agents, onOpen }: { agents: AgentCardData[]; onOpen?: (id: string) => void }) {
  if (!agents.length) return <p className="text-[13px] text-t3">No agent telemetry in this period.</p>;
  return (
    <CardGrid>
      {agents.map((a) => (
        <AgentCard key={a.id} agent={a} onOpen={onOpen} />
      ))}
    </CardGrid>
  );
}

/** The hero card: net value large, then ROI, value, cost, outcomes, cost per outcome; one "How" for net and ROI. */
export function ValueHero({ totals, currency }: { totals: ValueFigures; currency: string }) {
  return (
    <Card className="flex flex-col gap-3" testId="value-hero">
      <div className="flex flex-col gap-1">
        <span className="text-[12px] text-t3">Net value</span>
        <span
          className={cn(
            'font-mono text-[34px] font-semibold leading-none tracking-tight tabular-nums',
            totals.net < 0 ? 'text-rd' : 'text-t1',
          )}
        >
          {formatMoney(totals.net, currency)}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Figure label="ROI" value={formatRoi(totals.roi)} />
        <Figure label="Value" value={formatMoney(totals.value, currency)} />
        <Figure label="Cost" value={formatMoney(totals.cost, currency, { cost: true })} />
        <Figure label="Outcomes" value={formatOutcomes(totals.outcomes)} />
        <Figure
          label="Cost per outcome"
          value={totals.costPerOutcome === null ? '—' : formatMoney(totals.costPerOutcome, currency, { cost: true })}
          className="col-span-2"
        />
      </div>
      <How
        text={[totals.how.net, `ROI: ${totals.how.roi}`, `Cost per outcome: ${totals.how.costPerOutcome}`].join('\n')}
      />
    </Card>
  );
}

/** One agent's value: net, ROI, value, cost, its outcome lines and adoption. */
export function ValueAgentCard({
  row,
  currency,
  onOpen,
}: {
  row: ValueAgentRow;
  currency: string;
  onOpen?: (row: ValueAgentRow) => void;
}) {
  const body = (
    <Card
      className={cn('flex h-full flex-col gap-2.5', onOpen && 'transition-colors hover:border-bd')}
      testId="value-agent-card"
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-t1" title={row.name}>
            {row.name}
          </p>
          <p className="truncate font-mono text-[11px] text-t3">{row.service}</p>
        </div>
        <FamilyBadge family={row.family} />
      </div>
      {!row.seen ? (
        <p className="text-[12px] text-t3">No runs in this period.</p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2">
            <Figure label="Net" value={formatMoney(row.net, currency)} tone={row.net < 0 ? 'danger' : undefined} />
            <Figure label="ROI" value={formatRoi(row.roi)} />
            <Figure label="Value" value={formatMoney(row.value, currency)} />
            <Figure label="Cost" value={formatMoney(row.cost, currency, { cost: true })} />
          </div>
          {row.lines.length > 0 && (
            <ul className="flex flex-col gap-1 border-t border-hair pt-2 text-[12px]">
              {row.lines.map((l) => (
                <li key={l.outcomeId} className="min-w-0">
                  <span className="font-semibold text-t1">{l.name}</span>
                  <span className="text-t3">: </span>
                  <span className="break-words font-mono text-[11px] text-t2">{l.how}</span>
                </li>
              ))}
            </ul>
          )}
          {row.adoption && (
            <p className="text-[12px] text-t3">
              {plural(row.adoption.users, 'user')} · {plural(row.adoption.sessions, 'session')} ·{' '}
              {plural(row.adoption.runs, row.adoption.runUnit)}
            </p>
          )}
          <How text={[row.how.net, `ROI: ${row.how.roi}`, `Cost: ${row.costHow}`].join('\n')} />
        </>
      )}
    </Card>
  );
  if (!onOpen) return body;
  return (
    <div
      role="link"
      tabIndex={0}
      className="block h-full cursor-pointer text-left"
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(row);
      }}
    >
      {body}
    </div>
  );
}

/** The value panel: the hero card and the agents (the top three when `compact`). */
export function ValueSummary({
  report,
  compact,
  onOpenAgent,
}: {
  report: ValueReportResponse;
  compact?: boolean;
  onOpenAgent?: (row: ValueAgentRow) => void;
}) {
  const rows = compact ? report.agents.slice(0, 3) : report.agents;
  return (
    <div className="flex flex-col gap-3">
      <ValueHero totals={report.totals} currency={report.currency} />
      {rows.length > 0 && (
        <CardGrid>
          {rows.map((row) => (
            <ValueAgentCard key={row.key} row={row} currency={report.currency} onOpen={onOpenAgent} />
          ))}
        </CardGrid>
      )}
      {compact && report.agents.length > 3 && (
        <p className="text-[12px] text-t3">and {report.agents.length - 3} more agents</p>
      )}
    </div>
  );
}
