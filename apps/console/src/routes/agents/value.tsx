import { useNavigate } from 'react-router';
import { Bot, X } from 'lucide-react';
import {
  agentIdOf,
  Card,
  CardGrid,
  Chip,
  EmptyState,
  Figure,
  formatMoney,
  formatOutcomes,
  formatRoi,
  How,
  ValueAgentCard,
  ValueHero,
} from '@clickland/ui';
import { AgentsFrame, DOCS_CLAUDE_CODE, Loaded, Section, TruncatedBanner } from '@/components/agents/agents-frame';
import { useAgentPeriod, useValueReport } from '@/lib/agents';

export function NoAgents() {
  return (
    <Card>
      <EmptyState
        icon={<Bot className="size-5" />}
        title="No agent telemetry in this period"
        hint={
          <>
            Agents show up once their runs send OpenTelemetry spans or Claude Code metrics.{' '}
            <a href={DOCS_CLAUDE_CODE} target="_blank" rel="noreferrer" className="text-ac hover:underline">
              Send Claude Code’s telemetry
            </a>
          </>
        }
      />
    </Card>
  );
}

/** /agents : what the AI agents are worth in the period, per agent, team and outcome. */
export function AgentValuePage() {
  const navigate = useNavigate();
  const { bounds, carry, params, setParams } = useAgentPeriod();
  const team = params.get('team');
  const report = useValueReport(bounds, { team });
  const setTeam = (next: string | null) => {
    const p = new URLSearchParams(params);
    if (next) p.set('team', next);
    else p.delete('team');
    setParams(p);
  };
  return (
    <AgentsFrame>
      {team && (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-t3">Team</span>
          <button type="button" onClick={() => setTeam(null)} aria-label={`Clear the team ${team}`}>
            <Chip tone="accent">
              {team} <X className="size-3" />
            </Chip>
          </button>
        </div>
      )}
      <Loaded query={report}>
        {(r) => {
          const c = r.currency;
          if (!r.agents.length && !r.outcomes.some((o) => o.credited + o.unattributed > 0)) return <NoAgents />;
          return (
            <>
              <TruncatedBanner truncated={r.truncated} />
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <ValueHero totals={r.totals} currency={c} />
                <Card className="flex flex-col gap-2">
                  <Figure label="Hourly rate" value={`${formatMoney(r.hourlyRate, c)} / h`} />
                  <How label="How is this computed?" text={r.model} />
                </Card>
              </div>

              <Section title="Agents" aside={`${r.agents.length}`}>
                <CardGrid>
                  {r.agents.map((row) => (
                    <ValueAgentCard
                      key={row.key}
                      row={row}
                      currency={c}
                      onOpen={(a) => navigate(`/agents/${agentIdOf(a.key)}${carry}`)}
                    />
                  ))}
                </CardGrid>
              </Section>

              {r.teams.length > 0 && (
                <Section title="Teams">
                  <CardGrid>
                    {r.teams.map((t) => (
                      <button key={t.team} type="button" className="text-left" onClick={() => setTeam(t.team)}>
                        <Card className="flex flex-col gap-2 transition-colors hover:border-bd">
                          <p className="truncate text-[14px] font-semibold text-t1">{t.team}</p>
                          <div className="grid grid-cols-4 gap-2">
                            <Figure label="Net" value={formatMoney(t.net, c)} tone={t.net < 0 ? 'danger' : undefined} />
                            <Figure label="ROI" value={formatRoi(t.roi)} />
                            <Figure label="Value" value={formatMoney(t.value, c)} />
                            <Figure label="Cost" value={formatMoney(t.cost, c, { cost: true })} />
                          </div>
                        </Card>
                      </button>
                    ))}
                  </CardGrid>
                </Section>
              )}

              <Section title="Outcomes">
                <CardGrid>
                  {r.outcomes.map((o) => {
                    const searchable = o.signal === 'traces' || o.signal === 'logs';
                    const body = (
                      <Card className="flex h-full flex-col gap-2" testId="outcome-card">
                        <div className="flex items-start gap-2">
                          <p className="min-w-0 flex-1 text-[14px] font-semibold text-t1">{o.name}</p>
                          <span className="font-mono text-[13px] font-semibold text-t1">{formatMoney(o.value, c)}</span>
                        </div>
                        <p className="text-[12px] text-t2">{o.unitHow}</p>
                        <div className="grid grid-cols-2 gap-2">
                          <Figure label="Credited" value={formatOutcomes(o.credited)} />
                          <Figure label="Not credited" value={formatOutcomes(o.unattributed)} />
                        </div>
                        <code className="break-words rounded-lg bg-sf2 px-2 py-1 font-mono text-[11px] text-t2">
                          {o.search}
                        </code>
                        <How text={o.how} />
                      </Card>
                    );
                    return searchable ? (
                      <div
                        key={o.id}
                        role="link"
                        tabIndex={0}
                        className="cursor-pointer"
                        onClick={() =>
                          navigate(
                            `/search?${new URLSearchParams({ signal: o.signal, query: o.search.replace(/^(traces|logs): /, ''), from: bounds.from, to: bounds.to })}`,
                          )
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.click();
                        }}
                      >
                        {body}
                      </div>
                    ) : (
                      <div key={o.id}>{body}</div>
                    );
                  })}
                </CardGrid>
              </Section>

              {r.unattributed.outcomes > 0 && (
                <Section title="Not counted">
                  <Card className="flex flex-col gap-1.5">
                    <div className="flex gap-4">
                      <Figure label="Outcomes" value={formatOutcomes(r.unattributed.outcomes)} />
                      <Figure label="Value" value={formatMoney(r.unattributed.value, c)} />
                    </div>
                    <p className="text-[12px] text-t2">{r.unattributed.note}</p>
                  </Card>
                </Section>
              )}
            </>
          );
        }}
      </Loaded>
    </AgentsFrame>
  );
}
