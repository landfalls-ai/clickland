import { Link, useParams } from 'react-router';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { AgentRunSummary, AgentSummary } from '@clickland/contracts';
import {
  Badge,
  Card,
  CardGrid,
  Chip,
  FamilyBadge,
  Figure,
  formatCount,
  formatMoney,
  formatRunDuration,
  formatSuccess,
  formatTime,
  formatTokens,
  How,
  StatusDot,
  ValueAgentCard,
} from '@clickland/ui';
import { AgentsFrame, Loaded, Section } from '@/components/agents/agents-frame';
import { ApiError } from '@/lib/api';
import { useAgentDetail, useAgentPeriod, useValueSettings } from '@/lib/agents';

const COST_TONE = { priced: 'success', reported: 'accent', unpriced: 'warning', none: 'muted' } as const;

function Header({ a }: { a: AgentSummary }) {
  return (
    <Card className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <FamilyBadge family={a.family} />
        <span className="font-mono text-[12px] text-t2">{a.service}</span>
      </div>
      {(a.sources.length > 0 || a.teams.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {a.sources.map((s) => (
            <Chip key={s} mono>
              {s}
            </Chip>
          ))}
          {a.teams.map((t) => (
            <Chip key={t} tone="accent">
              team {t}
            </Chip>
          ))}
        </div>
      )}
      <p className="text-[12px] text-t3">
        First seen {formatTime(a.firstSeen, { date: true, ms: false })} · last seen{' '}
        {formatTime(a.lastSeen, { date: true, ms: false })}
      </p>
    </Card>
  );
}

function Operations({ a }: { a: AgentSummary }) {
  const unit = a.runUnit === 'run' ? 'Runs' : `${a.runUnit[0]!.toUpperCase()}${a.runUnit.slice(1)}s`;
  const latency = a.latencyOf === 'model call' ? 'per model call' : 'per run';
  const ends = Object.entries(a.endReasons);
  return (
    <Card className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
        <Figure label={unit} value={formatCount(a.runs)} />
        <Figure label="Failed" value={formatCount(a.failedRuns)} tone={a.failedRuns ? 'danger' : undefined} />
        <Figure label="Success" value={formatSuccess(a.successRate)} />
        <Figure label={`p50 ${latency}`} value={formatRunDuration(a.p50Ms)} />
        <Figure label={`p95 ${latency}`} value={formatRunDuration(a.p95Ms)} />
        <Figure label="Sub-agent runs" value={formatCount(a.subAgentRuns)} />
        <Figure label="Model calls" value={formatCount(a.modelCalls)} />
        <Figure label="Tool calls" value={formatCount(a.toolCalls)} />
        <Figure label="Step errors" value={formatCount(a.stepErrors)} tone={a.stepErrors ? 'danger' : undefined} />
        <Figure label="Rate limits" value={formatCount(a.rateLimits)} tone={a.rateLimits ? 'danger' : undefined} />
        <Figure label="Retries" value={formatCount(a.retries)} />
        <Figure label="Loops" value={formatCount(a.loops)} tone={a.loops ? 'danger' : undefined} />
        <Figure label="Tokens in" value={formatTokens(a.inputTokens)} />
        <Figure label="Tokens out" value={formatTokens(a.outputTokens)} />
        <Figure label="Cache read" value={formatTokens(a.cacheReadTokens)} />
        <Figure label="Cache write" value={formatTokens(a.cacheWriteTokens)} />
        <Figure label="Users" value={formatCount(a.users)} />
        <Figure label="Sessions" value={formatCount(a.sessions)} />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-hair pt-2.5">
        <Figure label="Cost" value={formatMoney(a.costUsd, 'USD', { cost: true })} />
        {a.unpricedModels.length > 0 && <Chip tone="warning">unpriced: {a.unpricedModels.join(', ')}</Chip>}
      </div>
      <How text={a.costHow} />
      {ends.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {ends.map(([reason, n]) => (
            <Chip key={reason}>
              {reason} · {n}
            </Chip>
          ))}
        </div>
      )}
    </Card>
  );
}

function Cost({ a }: { a: AgentSummary }) {
  if (!a.models.length) return <p className="text-[13px] text-t3">No model calls in this period.</p>;
  return (
    <CardGrid>
      {a.models.map((m) => (
        <Card key={m.model} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-t1">{m.model}</span>
            <Badge tone={COST_TONE[m.costSource]}>{m.costSource}</Badge>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Figure label="Calls" value={formatCount(m.calls)} />
            <Figure
              label="Tokens in / out"
              value={`${formatTokens(m.inputTokens)} / ${formatTokens(m.outputTokens)}`}
            />
            <Figure label="Cost" value={formatMoney(m.costUsd, 'USD', { cost: true })} />
          </div>
          <How text={m.how} />
        </Card>
      ))}
    </CardGrid>
  );
}

function Tools({ a }: { a: AgentSummary }) {
  const p = a.permissions;
  return (
    <div className="flex flex-col gap-3">
      {a.tools.length ? (
        <Card className="flex flex-col divide-y divide-hair px-0 py-0">
          {a.tools.map((t) => (
            <div key={`${t.kind}:${t.name}`} className="flex items-center gap-2 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[13px] text-t1">{t.name}</span>
              <Chip mono>{t.kind}</Chip>
              <span className="font-mono text-[12px] text-t2">{formatCount(t.calls)}</span>
              {t.errors > 0 && (
                <Chip tone="danger">
                  {t.errors} {t.errors === 1 ? 'error' : 'errors'}
                </Chip>
              )}
            </div>
          ))}
        </Card>
      ) : (
        <p className="text-[13px] text-t3">No tool calls in this period.</p>
      )}
      <Card className="flex flex-col gap-2">
        <p className="text-[12px] font-semibold text-t2">Permissions</p>
        {p.tools.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {p.tools.map((t) => (
              <li key={`${t.kind}:${t.name}`} className="flex flex-wrap items-center gap-1.5 text-[12px]">
                <span className="font-semibold text-t1">{t.name}</span>
                <Chip tone="success">{t.allowed} allowed</Chip>
                {t.denied > 0 && <Chip tone="danger">{t.denied} denied</Chip>}
                {Object.entries(t.sources).map(([s, n]) => (
                  <Chip key={s} mono>
                    {s} · {n}
                  </Chip>
                ))}
              </li>
            ))}
          </ul>
        )}
        {p.modes.length > 0 && (
          <p className="text-[12px] text-t2">
            Modes: <span className="font-mono">{p.modes.join(', ')}</span>
          </p>
        )}
        {p.needsApproval.length > 0 && (
          <p className="text-[12px] text-t2">
            Needs approval: <span className="font-mono">{p.needsApproval.join(', ')}</span>
          </p>
        )}
        <p className="text-[12px] text-t3">{p.note}</p>
      </Card>
    </div>
  );
}

function Quality({ a }: { a: AgentSummary }) {
  return (
    <Card className="flex flex-col gap-3">
      {a.evaluations.length ? (
        <ul className="flex flex-col gap-1.5">
          {a.evaluations.map((e) => (
            <li key={e.name} className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="font-semibold text-t1">{e.name}</span>
              <span className="text-t3">
                {e.count} · average {e.averageScore === null ? '—' : e.averageScore.toFixed(2)}
              </span>
              {Object.entries(e.labels).map(([label, n]) => (
                <Chip key={label}>
                  {label} · {n}
                </Chip>
              ))}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-t3">No evaluations in this period.</p>
      )}
      <div className="flex flex-wrap items-center gap-4 text-[13px] text-t1">
        <span className="flex items-center gap-1.5" title="Thumbs up">
          <ThumbsUp className="size-4 text-gn" /> {a.feedback.up}
        </span>
        <span className="flex items-center gap-1.5" title="Thumbs down">
          <ThumbsDown className="size-4 text-rd" /> {a.feedback.down}
        </span>
        <span className="text-[12px] text-t2">
          Approvals: {a.approvals.approved} approved, {a.approvals.denied} denied
        </span>
      </div>
    </Card>
  );
}

function RecentRuns({ runs, carry }: { runs: AgentRunSummary[]; carry: string }) {
  if (!runs.length) return <p className="text-[13px] text-t3">No runs in this period.</p>;
  return (
    <Card className="flex flex-col divide-y divide-hair px-0 py-0">
      {runs.map((r) => (
        <Link
          key={`${r.traceId}:${r.spanId}`}
          to={`/agents/runs/${r.traceId}${carry}`}
          className="flex flex-col gap-1 px-4 py-2.5 hover:bg-sf2 md:flex-row md:items-center md:gap-3"
        >
          <span className="flex items-center gap-2">
            <StatusDot status={r.status === 'ok' ? 'up' : 'down'} label={r.status} />
            <span className="font-mono text-[12px] text-t1">{formatTime(r.startedAt, { date: true, ms: false })}</span>
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] text-t2 md:flex-1">
            <span>{formatRunDuration(r.durationMs)}</span>
            <span>
              {formatTokens(r.inputTokens)} / {formatTokens(r.outputTokens)} tok
            </span>
            <span>{formatMoney(r.costUsd, 'USD', { cost: true })}</span>
            {r.errorType && <span className="text-rd">{r.errorType}</span>}
          </span>
          <span className="flex flex-wrap gap-1.5">
            {r.retries > 0 && (
              <Chip tone="warning">
                {r.retries} {r.retries === 1 ? 'retry' : 'retries'}
              </Chip>
            )}
            {r.rateLimits > 0 && (
              <Chip tone="danger">
                {r.rateLimits} {r.rateLimits === 1 ? 'rate limit' : 'rate limits'}
              </Chip>
            )}
            {r.loops.map((l) => (
              <Chip key={l.tool} tone="danger">
                loop: {l.tool} ×{l.count}
              </Chip>
            ))}
          </span>
        </Link>
      ))}
    </Card>
  );
}

/** /agents/:id : one agent in full. */
export function AgentPage() {
  const { id } = useParams();
  const { bounds, carry } = useAgentPeriod();
  const detail = useAgentDetail(id, bounds);
  const settings = useValueSettings();
  const notFound = detail.error instanceof ApiError && detail.error.status === 404;
  const a = detail.data?.agent;
  const currency = settings.data?.currency ?? 'USD';
  return (
    <AgentsFrame back={{ to: `/agents/list${carry}`, label: 'All agents' }} title={a?.name ?? 'Agent'}>
      {notFound ? (
        <Card>
          <p className="text-[13px] text-t2">This agent has no telemetry in this period.</p>
        </Card>
      ) : (
        <Loaded query={detail}>
          {(d) => (
            <>
              <Header a={d.agent} />
              <Section title="Operations">
                <Operations a={d.agent} />
              </Section>
              <Section title="Cost">
                <Cost a={d.agent} />
              </Section>
              <Section title="Tools and permissions">
                <Tools a={d.agent} />
              </Section>
              <Section title="Quality">
                <Quality a={d.agent} />
              </Section>
              {d.value && (
                <Section title="Value">
                  <ValueAgentCard row={d.value} currency={currency} />
                </Section>
              )}
              {Object.keys(d.agent.activity).length > 0 && (
                <Section title="Activity">
                  <Card className="flex flex-col divide-y divide-hair px-0 py-0">
                    {Object.entries(d.agent.activity).map(([k, v]) => (
                      <div key={k} className="flex items-center px-4 py-2 text-[13px]">
                        <span className="flex-1 text-t2">{k}</span>
                        <span className="font-mono text-t1">{formatCount(v)}</span>
                      </div>
                    ))}
                  </Card>
                </Section>
              )}
              {d.agent.runUnit === 'run' && (
                <Section title="Recent runs">
                  <RecentRuns runs={d.recentRuns} carry={carry} />
                </Section>
              )}
            </>
          )}
        </Loaded>
      )}
    </AgentsFrame>
  );
}
