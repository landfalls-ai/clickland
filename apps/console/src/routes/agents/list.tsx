import { useNavigate } from 'react-router';
import type { AgentFamily } from '@clickland/contracts';
import { AgentCards, cn, FAMILY_LABEL } from '@clickland/ui';
import { AgentsFrame, Loaded, TruncatedBanner } from '@/components/agents/agents-frame';
import { useAgentList, useAgentPeriod } from '@/lib/agents';
import { NoAgents } from './value';

const FAMILIES: Array<AgentFamily | null> = [null, 'landflow', 'a2a', 'landfall', 'claude_code', 'genai'];

/** /agents/list : every agent seen in the period, filtered by family. */
export function AgentListPage() {
  const navigate = useNavigate();
  const { bounds, carry, params, setParams } = useAgentPeriod();
  const raw = params.get('family');
  const family = FAMILIES.includes(raw as AgentFamily) ? (raw as AgentFamily) : null;
  const list = useAgentList(bounds, family);
  const setFamily = (f: AgentFamily | null) => {
    const p = new URLSearchParams(params);
    if (f) p.set('family', f);
    else p.delete('family');
    setParams(p);
  };
  return (
    <AgentsFrame>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0" aria-label="Family">
        {FAMILIES.map((f) => (
          <button
            key={f ?? 'all'}
            type="button"
            aria-pressed={family === f}
            onClick={() => setFamily(f)}
            className={cn(
              'h-8 shrink-0 whitespace-nowrap rounded-full border px-3 text-[12px] transition-colors',
              family === f ? 'border-ac bg-acdim font-semibold text-t1' : 'border-hair text-t2 hover:border-bd',
            )}
          >
            {f ? FAMILY_LABEL[f] : 'All'}
          </button>
        ))}
      </div>
      <Loaded query={list}>
        {(d) =>
          !d.agents.length && !family ? (
            <NoAgents />
          ) : (
            <>
              <TruncatedBanner truncated={d.truncated} />
              <AgentCards agents={d.agents} onOpen={(id) => navigate(`/agents/${id}${carry}`)} />
            </>
          )
        }
      </Loaded>
    </AgentsFrame>
  );
}
