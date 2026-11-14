/** The MCP tools of docs/agent-value.md, so an assistant can answer "what is our AI worth this week?". */
import type { ApiScope, ValueReportResponse } from '@clickland/contracts';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Services } from './services.js';

type Tool = <S extends z.ZodType>(
  name: string,
  config: { title: string; description: string; inputSchema: S; scope?: ApiScope; ui?: boolean; readOnly?: boolean },
  run: (args: z.output<S>) => Promise<CallToolResult>,
) => void;

const period = {
  lastDays: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe('The last N days (default 7). Ignored when from is set.'),
  from: z.string().optional().describe('ISO time'),
  to: z.string().optional().describe('ISO time'),
  service: z.string().max(300).optional().describe('A service name, or a prefix ending in * (demo-*)'),
};

function range(a: { lastDays?: number; from?: string; to?: string }) {
  if (a.from || !a.lastDays) return { from: a.from, to: a.to };
  const to = a.to ? new Date(a.to) : new Date();
  return { from: new Date(to.getTime() - a.lastDays * 86_400_000).toISOString(), to: to.toISOString() };
}

const money = (n: number, currency: string) =>
  `${currency === 'USD' ? '$' : `${currency} `}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(0)}%`);

/** The report in words, with the arithmetic, so a model quotes numbers it can explain. */
export function valueText(report: ValueReportResponse): string {
  const c = report.currency;
  const lines = [
    `AI agent value, ${report.from.slice(0, 10)} to ${report.to.slice(0, 10)} (${c}, ${money(report.hourlyRate, c)}/h):`,
    `Total: value ${money(report.totals.value, c)}, cost ${money(report.totals.cost, c)}, net ${money(report.totals.net, c)}, ROI ${percent(report.totals.roi)}, ${report.totals.outcomes} outcomes.`,
    `How: ${report.totals.how.net}; ROI ${report.totals.how.roi}.`,
    '',
    'Per agent:',
    ...report.agents
      .slice(0, 15)
      .map(
        (a) =>
          `- ${a.name} (${a.service}): value ${money(a.value, c)}, cost ${money(a.cost, c)}, net ${money(a.net, c)}, ROI ${percent(a.roi)}, ${a.outcomes} outcomes${
            a.lines.length ? ` [${a.lines.map((l) => `${l.name}: ${l.how}`).join('; ')}]` : ''
          }`,
      ),
    '',
    'Outcomes:',
    ...report.outcomes.map((o) => `- ${o.name}: ${o.how} (${o.unitHow}; counted by ${o.search})`),
  ];
  if (report.unattributed.outcomes > 0)
    lines.push(
      '',
      `Not counted: ${report.unattributed.outcomes} outcomes no agent took part in (${money(report.unattributed.value, c)}).`,
    );
  if (report.truncated)
    lines.push('', 'The period held more spans than one question reads; the figures cover the newest.');
  lines.push('', report.model);
  return lines.join('\n');
}

const result = (data: unknown, text?: string): CallToolResult => ({
  content: [{ type: 'text', text: text ?? JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
});

export function registerAgentTools(tool: Tool, services: Services): void {
  const { agents } = services;

  tool(
    'list_agents',
    {
      title: 'List AI agents',
      description:
        'Every AI agent seen in telemetry (Landflow agents, kagent over A2A, Claude Code, the Landfall investigator): runs, success rate, latency, tokens, cost, errors, rate limits, retries, loops, models and tools. Default: the last 7 days.',
      ui: true,
      inputSchema: z.object(period),
    },
    async (a) => {
      const { agents: list, ...rest } = await agents.list({ ...range(a), service: a.service });
      // The list is for choosing: the full figures of one agent are a get_agent call away.
      return result({
        ...rest,
        agents: list.map((x) => ({
          id: x.id,
          name: x.name,
          service: x.service,
          family: x.family,
          runs: x.runs,
          runUnit: x.runUnit,
          successRate: x.successRate,
          p95Ms: x.p95Ms,
          inputTokens: x.inputTokens,
          outputTokens: x.outputTokens,
          costUsd: x.costUsd,
          stepErrors: x.stepErrors,
          rateLimits: x.rateLimits,
          retries: x.retries,
          loops: x.loops,
          models: x.models.map((m) => m.model),
          tools: x.tools.map((t) => t.name),
          users: x.users,
          lastSeen: x.lastSeen,
        })),
      });
    },
  );

  tool(
    'get_agent',
    {
      title: 'Get an AI agent',
      description:
        'One agent in full: operations, cost per model with the arithmetic, tools and permissions, evaluations, recent runs (each with a traceId for run_graph) and its value. `agent` is an id from list_agents, or the agent’s name.',
      inputSchema: z.object({ agent: z.string().min(1).max(700), ...period }),
    },
    async (a) => result(await agents.detail(a.agent, { ...range(a), service: a.service })),
  );

  tool(
    'agent_value',
    {
      title: 'AI agent value',
      description:
        'What the AI agents are worth in a period: value, cost, net value, ROI and cost per outcome, per agent, per team and per outcome, each with how it was computed. Answers "what is our AI worth this week?" (default: the last 7 days). Filter with agent (id or name) or team.',
      ui: true,
      inputSchema: z.object({
        ...period,
        agent: z.string().max(700).optional(),
        team: z.string().max(200).optional(),
      }),
    },
    async (a) => {
      const report = await agents.value({ ...range(a), service: a.service, agent: a.agent, team: a.team });
      return result(report, valueText(report));
    },
  );

  tool(
    'run_graph',
    {
      title: 'An agent run’s decision path',
      description:
        'The decision path of one trace: agents, model calls, tool calls and sub-agents as nodes (latency, tokens, cost, errors, retries, loops) with edges from each step to the step that called it.',
      ui: true,
      inputSchema: z.object({ traceId: z.string().regex(/^[0-9a-fA-F]{1,64}$/) }),
    },
    async (a) => result(await agents.graph(a.traceId)),
  );
}
