import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Repeat, Waypoints } from 'lucide-react';
import type { RunGraphNode } from '@clickland/contracts';
import {
  Button,
  Card,
  ErrorNote,
  Figure,
  formatCount,
  formatMoney,
  formatRunDuration,
  formatTokens,
  KeyValues,
  RunGraph,
} from '@clickland/ui';
import { AgentsFrame, Loaded, Section } from '@/components/agents/agents-frame';
import { Drawer } from '@/components/ui/dialog';
import { useAgentPeriod, useRunGraph } from '@/lib/agents';

/** Every field of a node, as text (the sheet's list). */
function nodeFields(node: RunGraphNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node)) {
    if (v === '' || v === null || v === undefined) continue;
    if (k === 'costHow' || k === 'statusMessage') continue;
    out[k] = typeof v === 'number' ? (k === 'costUsd' ? formatMoney(v, 'USD', { cost: true }) : String(v)) : String(v);
  }
  return out;
}

/** /agents/runs/:traceId : one run's decision path. */
export function RunPage() {
  const { traceId = '' } = useParams();
  const navigate = useNavigate();
  const { carry } = useAgentPeriod();
  const graph = useRunGraph(traceId);
  const [selected, setSelected] = useState<RunGraphNode | null>(null);
  return (
    <AgentsFrame
      back={{ to: `/agents/list${carry}`, label: 'All agents' }}
      title={<span className="font-mono">Run {traceId.slice(0, 12)}</span>}
      period={false}
      meta={
        <Button size="sm" onClick={() => navigate(`/traces/${traceId}`)}>
          <Waypoints className="size-3.5" /> Open trace
        </Button>
      }
    >
      <Loaded query={graph}>
        {(g) => {
          const s = g.summary;
          return (
            <>
              <Card className="grid grid-cols-4 gap-3 md:grid-cols-8" testId="run-summary">
                <Figure label="Duration" value={formatRunDuration(g.durationMs)} />
                <Figure label="Agents" value={formatCount(s.agentRuns)} />
                <Figure label="Model calls" value={formatCount(s.modelCalls)} />
                <Figure label="Tool calls" value={formatCount(s.toolCalls)} />
                <Figure label="Tokens" value={formatTokens(s.inputTokens + s.outputTokens)} />
                <Figure label="Cost" value={formatMoney(s.costUsd, 'USD', { cost: true })} />
                <Figure label="Errors" value={formatCount(s.errors)} tone={s.errors ? 'danger' : undefined} />
                <Figure label="Retries" value={formatCount(s.retries)} />
              </Card>
              {g.loops.map((l) => (
                <p
                  key={`${l.agent}:${l.tool}`}
                  role="status"
                  className="flex items-center gap-2 rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd"
                >
                  <Repeat className="size-3.5 shrink-0" />
                  <span>
                    <span className="font-mono font-semibold">{l.tool}</span> was called {l.count} times in a row by{' '}
                    <span className="font-semibold">{l.agent}</span>
                  </span>
                </p>
              ))}
              <Section title="Decision path" aside={s.agents.join(', ')}>
                <Card className="px-2 py-2 md:px-4 md:py-4">
                  <RunGraph graph={g} onSelect={setSelected} />
                </Card>
              </Section>
            </>
          );
        }}
      </Loaded>
      {selected && (
        <Drawer
          title={selected.label}
          onClose={() => setSelected(null)}
          actions={
            <Button size="sm" onClick={() => navigate(`/traces/${traceId}`)}>
              Open in trace
            </Button>
          }
        >
          <div className="flex flex-col gap-3">
            {selected.statusMessage && <ErrorNote error={selected.statusMessage} />}
            {selected.costHow && (
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-semibold text-t2">How the cost was computed</span>
                <p className="rounded-lg bg-sf2 px-2.5 py-1.5 font-mono text-[11px] text-t2">{selected.costHow}</p>
              </div>
            )}
            <KeyValues values={nodeFields(selected)} />
          </div>
        </Drawer>
      )}
    </AgentsFrame>
  );
}
