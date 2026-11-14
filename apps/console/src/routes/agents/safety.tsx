import { Link } from 'react-router';
import { ShieldCheck } from 'lucide-react';
import { Badge, Card, CardGrid, EmptyState, Figure, formatCount, formatTime } from '@clickland/ui';
import { AgentsFrame, Loaded, Section } from '@/components/agents/agents-frame';
import { useAgentPeriod, useSafety } from '@/lib/agents';

const KIND_LABEL = { pii: 'Personal data', secret: 'Secret', prompt_injection: 'Prompt injection' } as const;

/** /agents/safety : personal data, secrets and prompt injection found in captured content, masked. */
export function AgentSafetyPage() {
  const { bounds, carry } = useAgentPeriod();
  const safety = useSafety(bounds);
  return (
    <AgentsFrame>
      <Loaded query={safety}>
        {(s) =>
          !s.contentCaptured ? (
            <Card>
              <p className="text-[13px] text-t2">{s.note}</p>
            </Card>
          ) : (
            <>
              <Card className="flex flex-col gap-3">
                <div className="grid grid-cols-3 gap-3">
                  {(['pii', 'secret', 'prompt_injection'] as const).map((k) => (
                    <Figure
                      key={k}
                      label={KIND_LABEL[k]}
                      value={formatCount(s.totals[k])}
                      tone={s.totals[k] ? 'danger' : undefined}
                    />
                  ))}
                </div>
                <p className="text-[12px] text-t3">
                  {formatCount(s.scanned)} spans scanned. {s.note}
                </p>
              </Card>
              <Section title="Flags" aside={`${s.flags.length}`}>
                {!s.flags.length ? (
                  <Card>
                    <EmptyState compact icon={<ShieldCheck className="size-5" />} title="Nothing flagged" />
                  </Card>
                ) : (
                  <CardGrid>
                    {s.flags.map((f, i) => (
                      <Card
                        key={`${f.spanId}:${f.detector}:${i}`}
                        className="flex flex-col gap-1.5"
                        testId="safety-flag"
                      >
                        <div className="flex items-center gap-2">
                          <Badge tone={f.kind === 'secret' || f.kind === 'prompt_injection' ? 'danger' : 'warning'}>
                            {KIND_LABEL[f.kind]}
                          </Badge>
                          <span className="font-mono text-[12px] text-t2">{f.detector}</span>
                          {f.count > 1 && <span className="ml-auto text-[12px] text-t3">×{f.count}</span>}
                        </div>
                        <code className="break-words rounded-lg bg-sf2 px-2 py-1 font-mono text-[12px] text-t1">
                          {f.sample}
                        </code>
                        <p className="truncate font-mono text-[11px] text-t3">{f.attribute}</p>
                        <p className="text-[12px] text-t2">
                          {f.agent || 'an agent'} · <span className="font-mono">{f.service}</span> ·{' '}
                          {formatTime(f.at, { date: true, ms: false })}
                        </p>
                        <Link to={`/agents/runs/${f.traceId}${carry}`} className="text-[12px] text-ac hover:underline">
                          Open the run
                        </Link>
                      </Card>
                    ))}
                  </CardGrid>
                )}
              </Section>
            </>
          )
        }
      </Loaded>
    </AgentsFrame>
  );
}
