# AI agents: from visibility to business value

Clickland finds every AI agent in the land family's telemetry, shows how each one runs, and says what it is worth:
value, cost, net value and ROI, each with the arithmetic behind it.

Built: the queries, the API, the MCP tools, three panel types, the seed and the tests. Not built yet: the console
pages. Their spec is [at the end of this page](#console-spec).

## Where the idea comes from

Datadog announced "AI Agent Visibility to Business Value" in June 2025. It has four parts:

- **AI Agents Console** (preview): one list of in-house and third-party agents, with usage, impact, ROI, and the
  permissions each agent has.
- **AI Agent Monitoring** (generally available): a graph of each run's decision path (inputs, tool calls, calls to
  other agents, outputs) with latency, tokens, retries and errors per step.
- **LLM Experiments**: datasets made from production traces, evaluators, and cost, quality and latency compared
  across versions.
- **Security**: personal data, prompt injection and hallucination detection.

Sources: [Monitor AI agents](https://www.datadoghq.com/blog/monitor-ai-agents/),
[LLM Experiments](https://www.datadoghq.com/blog/llm-experiments/),
[Agent Observability](https://www.datadoghq.com/products/ai/agent-observability/).

Datadog says "prove ROI" and publishes **no formula**. The model on this page is Clickland's own.

## What Clickland has

1. [Agent inventory](#1-agent-inventory)
2. [Operations per agent](#2-operations-per-agent)
3. [The decision path of a run](#3-the-decision-path-of-a-run)
4. [Business value](#4-business-value)
5. [Quality and safety](#5-quality-and-safety)
6. [Alerts](#6-alerts)

Nothing about an agent is stored. Every answer is computed from spans, logs and metrics when it is asked. Postgres
holds only what the value is computed from: the hourly rate, the price table and the outcome definitions.

## 1. Agent inventory

An agent is a name inside a service: `landflow-host/Support triage`. Clickland finds agents four ways:

- **OpenTelemetry GenAI spans.** A span with `gen_ai.operation.name` = `invoke_agent` (or `invoke_workflow`) is a
  run. Its name is `gen_ai.agent.name`. Landflow's agents, agent teams and Telegram and Slack agents send these.
- **Landflow's workflow agent nodes.** The AI Agent node (`core.aiAgent`) and the team node (`core.runTeam`) open no
  `invoke_agent` span, so their `node.execute` span is the run, named by the node.
- **Remote agents over A2A** (kagent, the Claude Code harness). Landflow's client span carries
  `gen_ai.provider.name=a2a` and the tokens the remote agent reported.
- **Known spans and metrics.** Landfall's investigator is its `diagnosis.run` span. Claude Code is its
  `claude_code.*` metrics and events.

Each agent has a family: `landflow`, `a2a`, `landfall`, `claude_code` or `genai` (anything else on the conventions).

For each agent the inventory shows:

- its models, with tokens and cost per model
- the tools it called, with calls and errors
- its permissions, as far as telemetry says:
  - Landflow: which tools a person had to approve (`landflow.agent.approvals`)
  - Claude Code: each tool, how often it was allowed or rejected and by what (config, a hook, or the person), and
    the permission modes seen
- where its runs came from (schedule, Slack, Telegram, a workflow), its teams, and when it was first and last seen

Tools an agent may use but never called are not in telemetry, so they are not listed.

## 2. Operations per agent

- **Runs**: agent spans. For Claude Code a run is a prompt (or a session, when its events are not exported).
- **Success rate**: runs whose span did not end in an error ÷ runs. Unknown for Claude Code without its tracing.
- **Latency**: p50 and p95 of a run. For Claude Code: of a model call.
- **Tokens**: input, output, cache read and cache write, summed over the model calls under the run.
- **Cost**: tokens × the price table (below).
- **Errors**: model and tool steps that failed.
- **Rate limits**: failed steps with status 429 or 529, or an error type that says rate limit or overloaded.
- **Retries**: the same step again, right after it failed, under the same agent.
- **Loops**: one tool called 5 times or more back to back (with the same arguments, when the emitter captures
  them). The threshold is a setting.

How steps are credited:

- A model call or tool call belongs to the nearest agent span above it, through whatever spans sit between.
- A sub-agent's work stays with the sub-agent. Totals still add up.
- A tool span inside a tool call, or a model span inside a model call, is the same call and is counted once.
  (Landflow's `gen_ai.chat` wraps the SDK's own `anthropic.messages.create`.)

### The price table

- One row per model: USD per million tokens for input, output, cache read and cache write.
- A row's model is an id (`claude-opus-5-5`) or a prefix ending in `*`. The longest match wins, so
  `claude-opus-5-5*` beats `claude-opus-5*`. Cloud prefixes (`anthropic.`, `global.anthropic.`) are ignored.
- Seeded with Anthropic's list prices for every Claude model, read from
  [the pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on **2026-11-14**. Each row keeps its
  source and date.
- Every row is editable. A row you change is never overwritten by the seed again.
- When a model has no price, Clickland uses the cost the emitter reported (`landflow.ai.cost_usd`,
  `claude_code.cost.usage`). When there is neither, the cost is 0 and the model is listed as unpriced.
- `gen_ai.usage.input_tokens` includes cached tokens by the conventions, so cache reads and writes are taken out of
  the input before it is priced.

Not modelled: batch discounts, 1-hour cache writes (priced as 5-minute writes) and Claude Haiku 5.5's higher price
for prompts over 100,000 tokens.

## 3. The decision path of a run

`GET /api/agents/runs/:traceId/graph` turns a trace into a graph, using the same trace builder as the trace page:

- **Nodes**: agent, sub-agent, model call, tool call. Each has its duration, status, tokens, cost and the agent it
  ran under.
- **Edges**: from each step to the step that called it.
- Spans in between (HTTP, RPC, database) are folded into the step above and counted (`hiddenSpans`).
- The root span and any failed span are always kept, so a failure is never hidden.
- Retries and looping steps are marked. Loops are also listed on their own.
- Prompts and answers never ride in a graph.

## 4. Business value

### The model

- An **outcome** is a search over telemetry: spans, logs, or a counter metric.
- Each outcome has a **value**: minutes saved × the hourly rate ÷ 60, or a direct amount.
- **Value** of an agent = the outcomes credited to it × each outcome's value.
- **Net value** = value − cost.
- **ROI** = (value − cost) ÷ cost. Not defined when no cost was recorded.
- **Cost per outcome** = cost ÷ outcomes.

Every figure comes with a `how` line. From the demo data:

- `5 min saved × $60.00/h ÷ 60 = $5.00 each`
- `5 × $5.00 = $25.00`
- `9,500 input × $2/MTok + 2,320 output × $10/MTok = $0.0422`
- `($185.00 − $0.85) ÷ $0.85 = 21616%`

### Who gets an outcome

Each outcome says how it is credited:

- `trace`: the agents that ran in the outcome's trace share it equally. Sub-agents get no share.
- `correlate`: the agents whose runs carry the same value of a field, for example `incident.id`.
- `field`: the outcome's row names its agent, for example in `gen_ai.agent.name`.
- `agent`: always one agent.

An outcome that matched but that no agent took part in is **unattributed**. It is shown and left out of every
total: a workflow with no AI in it is not AI value.

### The seeded outcomes

The minutes are deliberately low. Change them once you have measured.

- **Landflow agent run completed**: 5 min. An agent's own run (schedule, Telegram, Slack) that did not fail. Test
  chats, sub-agents and runs inside a workflow are left out.
- **Landflow workflow run with an agent succeeded**: 10 min. Credited by trace.
- **Alert triaged**: 15 min. A successful run of a workflow whose name contains "triage".
- **Pull request merged by the SDLC flow**: 60 min. A successful run of a workflow whose name contains "SDLC".
- **Landfall investigation completed**: 20 min. A `diagnosis.run` that did not fail.
- **Landfall incident resolved with the investigator**: 30 min. Joined on `incident.id`. Counts nothing until
  Landfall names the event type on its timeline span ([below](#what-the-other-repos-need)).
- **Claude Code commit**: 15 min. The `claude_code.commit.count` metric.
- **Claude Code pull request**: 30 min. The `claude_code.pull_request.count` metric.

A workflow run is counted once: the triage and SDLC outcomes are excluded from the general workflow outcome.

### Per agent, period and team

`GET /api/agents/value` reports, for a period:

- **Totals**: value, cost, net, ROI, outcomes, cost per outcome.
- **Per agent**: the same, a line per outcome, adoption (active users, sessions, runs) and quality (success rate,
  evaluation scores, 👍/👎, approvals and denials).
- **Per team**: the same. A team is the value of a span, log or metric attribute (`team.id` by default), or the
  service's `service.namespace`.
- **Per outcome**: what was credited, what was not, and the search that counted it.

Filters: `agent`, `team`, `service`. The default period is the last 7 days.

### Settings

- Hourly rate: $60 by default.
- Currency: USD. Prices and amounts are in this one currency.
- Team attribute: `team.id`.
- Loop threshold: 5.

## 5. Quality and safety

**Evaluations.** Clickland reads `gen_ai.evaluation.result` events, on a span or as a log record: the evaluator's
name, the score and the label. Per agent it shows the count, the average score and the labels. An evaluation named
like "feedback" with a `thumbs_up` or `thumbs_down` label counts as 👍 or 👎.

**Human overrides.** Approvals and denials of an agent's tool calls: Landflow's `landflow.agent.approvals` metric,
and Claude Code's `tool_decision` events.

**Safety flags.** `GET /api/agents/safety` scans the newest spans that carry captured content
(`gen_ai.input.messages`, `gen_ai.output.messages`, system instructions, tool arguments and results) and Claude
Code prompts:

- personal data: email, phone, card number (checked with Luhn), US social security number, IBAN
- secrets: private keys, AWS keys, API keys, JWTs
- prompt injection: "ignore previous instructions", "reveal your system prompt", role overrides, "new
  instructions:", sending secrets somewhere

A flag carries a masked sample (`d***@a***.io`, `card ending 4242`), never the value. When no span carries content,
the answer says so: content capture is opt-in at the emitter.

These are pattern checks. They miss what only a model would catch, and there is no hallucination detection. That
belongs to an evaluator (Landflow has them) whose results Clickland then shows.

## 6. Alerts

Agent alerts use the existing alert machinery: a search, a count, a threshold, webhooks.
`GET /api/agents/alert-templates` lists ready alerts, and `POST /api/agents/alert-templates/:key/install` creates
one.

- **Errors**: agent runs failing (per agent), model rate limits (per model), tool calls failing (per tool).
- **Cost**: model calls that wrote over 20,000 output tokens (per model), model call volume (per service), Claude
  Code requests over $1.
- **Quality**: evaluation scores under 0.5 (per evaluator), Landflow's "flagged a low score" log line.

An alert counts rows; it cannot sum dollars. So spend is watched through calls that are expensive on their own and
through call volume. A true "more than $50 in an hour" alert needs a sum in the alert evaluator
([limits](#limits)).

## Claude Code's telemetry

Claude Code exports OpenTelemetry metrics and events. To send them to Clickland's collector, add this to
`~/.claude/settings.json`. **This is a proposal: nothing was changed on your machine.**

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "delta",
    "OTEL_RESOURCE_ATTRIBUTES": "team.id=platform"
  }
}
```

- It must be the user settings file. Claude Code ignores exporter variables in a repository's `.claude/settings.json`.
- `team.id` is the team the usage is reported under. Use your own.
- Metrics arrive every 60 seconds, events every 5.

Optional, each with a cost:

- `"OTEL_LOG_USER_PROMPTS": "1"`: sends prompt text, so the safety scan can read it. Off by default, for privacy.
- `"OTEL_LOG_TOOL_DETAILS": "1"`: sends tool parameters.
- `"CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1"` with `"OTEL_TRACES_EXPORTER": "otlp"`: sends spans (beta), which
  gives Claude Code runs, a success rate and a decision path.

What Clickland reads:

- metrics: `claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.commit.count`,
  `claude_code.pull_request.count`, `claude_code.lines_of_code.count`, `claude_code.session.count`,
  `claude_code.active_time.total`, `claude_code.code_edit_tool.decision`
- events: `user_prompt`, `api_request`, `api_error`, `tool_result`, `tool_decision`

The seeded Claude Code outcomes credit the agent `claude-code/Claude Code`. If Claude Code reports under another
service name, they find it by its name.

Source: [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage).

## API and MCP

The full contract is in [reference/api.md](reference/api.md#ai-agents).

- `GET /api/agents`: the inventory with operations
- `GET /api/agents/:id`: one agent, its recent runs and its value
- `GET /api/agents/runs/:traceId/graph`: a run's decision path
- `GET /api/agents/value`: the value report
- `GET /api/agents/safety`: safety flags
- `GET /api/agents/alert-templates`, `POST …/:key/install`
- `/api/value/settings`, `/api/value/prices`, `/api/value/outcomes` (with `preview`), `/api/value/seed`

MCP tools: `list_agents`, `get_agent`, `agent_value`, `run_graph`. `agent_value` answers "what is our AI worth this
week?" in words, with the arithmetic.

Panel types for views and dashboards: `agents`, `agent_value`, `run_graph`.

## Run it

```bash
pnpm dev:up && pnpm db:migrate                 # migration 0006_agent_value
node scripts/seed-agent-value.mjs              # prices and outcomes; safe to run again
node scripts/demo-agents.mjs                   # demo-* agent telemetry through the collector
curl 'http://127.0.0.1:4710/api/agents/value?service=demo-*'
```

Tests:

```bash
pnpm --filter @clickland/query test && pnpm --filter @clickland/api test
CLICKLAND_INTEGRATION=db pnpm --filter @clickland/query test:integration
CLICKLAND_INTEGRATION=db pnpm --filter @clickland/api test:integration
```

The API integration test sends its own batch through the collector under `demo-it-<time>-*` service names, reads
it back through the routes and the MCP tools, and deletes it.

## What is in telemetry today

Checked on 2026-11-14 against the local stack:

- **Landflow** (`landflow-host`): the alert triage flow's AI Agent node, "Triage the alert", ran 20 times and
  failed 20 times. Its model call ends in "Could not resolve authentication method": the cluster has no Anthropic
  credential. So it shows 20 runs, 0% success, no tokens and no value. No standalone agent, team or A2A run yet.
- **Landfall** (`core-api`): no `diagnosis.run` yet.
- **Claude Code**: not exporting (see the snippet above).
- **Demo** (`demo-*`, from `scripts/demo-agents.mjs`): 8 agents across all four families.

## What the other repos need

Nothing here was changed in another repository.

**Landflow**

1. An Anthropic credential for the triage flow on the cluster. Every real run fails without one.
2. The AI Agent node and the team node should open an `invoke_agent` span (`gen_ai.agent.name`,
   `gen_ai.conversation.id`) and `execute_tool` spans, as its agents already do. Clickland reads the node span
   until then.
3. Evaluations: send each result as a `gen_ai.evaluation.result` event with `gen_ai.evaluation.name`,
   `gen_ai.evaluation.score.value` and `gen_ai.evaluation.score.label`, on the run's span or as a log record with
   its trace id. Today only a flagged low score reaches Clickland, as a log line.
4. Chat 👍/👎: the same event, named `user_feedback`, labelled `thumbs_up` or `thumbs_down`.
5. Cache tokens on `gen_ai.chat`: `gen_ai.usage.cache_read.input_tokens` and
   `gen_ai.usage.cache_creation.input_tokens`, with `input_tokens` including them.
6. A team: `team.id` on the agent span or the resource. And the person as `user.id` (today
   `landflow.teams.user`, which Clickland also reads).
7. The SDLC flow's workflow name should contain "SDLC", or the outcome's search should be changed to its name.

**Landfall** (generic OpenTelemetry only, so it stays unaware of Clickland)

1. `diagnosis.run`: GenAI attributes (`gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`) and
   `gen_ai.usage.*` on its model calls. Today the investigator has runs and no cost.
2. `incidents.appendEventInTx`: an `incident.event.type` attribute, so a resolved incident can be counted and
   joined to the investigator on `incident.id`.
3. A service name that says Landfall (`OTEL_SERVICE_NAME=landfall-core-api`). `core-api` is anyone's.

**Claude Code**: the settings snippet above.

## Limits

- One question reads the newest 200,000 spans of the period. Past that the answer is marked `truncated`.
- A trace that started before the period is read from the period's start.
- Cost alerts are proxies. A sum of dollars per window needs an aggregate in the alert evaluator, which another
  branch is changing; it is the next step.
- Loops are one tool repeated back to back. A cycle between two agents is not detected.
- A sub-agent's cost stays with the sub-agent, and outcomes go to the top-level agent. Read ROI per agent with that
  in mind; the totals are right.
- One currency. Prices are USD list prices.
- The safety scan is patterns, not a model.
- Datadog's LLM Experiments (datasets from traces, releases compared) are not built. Landflow's evaluations own
  that; Clickland shows their results once they are sent.
- The Postgres migration is `0006_agent_value` (written as `0004` on its branch, renumbered when it merged after the Landfall migrations `0003`–`0005`).

<a id="console-spec"></a>

## Console spec

For the agent that owns `apps/console`, `apps/views` and `libs/ui`. Types come from `@clickland/contracts`
(`AgentsResponse`, `AgentSummary`, `AgentDetailResponse`, `RunGraphResponse`, `ValueReportResponse`,
`SafetyResponse`, `OutcomeDefinition`, `ModelPrice`, `ValueSettings`, `AgentAlertTemplate`).

### Rules for every page

- Phone first: one column of cards. No wide tables. From `md` up, cards sit in a 2 or 3 column grid.
- A period picker: 24 hours, 7 days (default), 30 days. It sets `from` and `to` on every call.
- Every money figure has a "How" disclosure that shows the `how` string as it comes. Never recompute it.
- Formatting:
  - money: the report's `currency`, 2 decimals; cost under 1 with 4 decimals
  - ROI: a percentage, no decimals; `null` is "—" with the `how.roi` text
  - outcomes: whole numbers, or 1 decimal when shared
  - success rate: a percentage; `null` is "not known"
  - durations: ms under 1 s, else seconds with 1 decimal
- States: a skeleton while loading; the API's `error.message` on failure; a "figures cover the newest spans only"
  banner when `truncated`.
- Empty state for no agents: "No agent telemetry in this period", with a link to this page's Claude Code section.

### Navigation

One entry, **Agents**, with four tabs: Value, Agents, Safety, Settings. Settings shows only to an admin.

### Value: `/agents`

Data: `GET /api/agents/value?from&to&team&service`.

1. **Hero card**: net value (large), then ROI, value, cost, outcomes, cost per outcome. One "How" for net and ROI.
2. **The model**: the `model` string, in a collapsed "How is this computed?" block.
3. **Agents**: one card per row of `agents`, sorted as returned. Name, family badge, service; net, ROI, value,
   cost; its `lines` as a short list (`name`: `how`); adoption (`users`, `sessions`, `runs` + `runUnit`). A row with
   `seen: false` says "no runs in this period". Tap opens the agent page.
4. **Teams**: one card per row of `teams`. Tap sets the `team` filter (a chip that can be cleared).
5. **Outcomes**: one card per row of `outcomes`. Name, `unitHow`, `how`, credited and unattributed, and the
   `search` in monospace. Tap opens the search page with that search when `signal` is `traces` or `logs`.
6. **Not counted**: `unattributed.note` with its count and value, when the count is over 0.

### Agents: `/agents/list`

Data: `GET /api/agents?from&to&family&service`.

- Filter chips for family: All, Landflow, A2A, Landfall, Claude Code, Other (`genai`).
- One card per agent: name, family badge, service; runs with `runUnit`; success rate; p50 and p95 with `latencyOf`
  as the label; tokens in and out; cost. Chips, shown only when over 0: errors (`stepErrors`), rate limits, retries,
  loops, unpriced models.
- Tap opens `/agents/:id`.

### One agent: `/agents/:id`

Data: `GET /api/agents/:id?from&to`. `404` shows "This agent has no telemetry in this period".

Sections, in this order:

1. **Header**: name, family, service, `sources`, `teams`, first and last seen.
2. **Operations**: the figures of the card above, in full.
3. **Cost**: one row per `models` entry: model, calls, tokens, `costUsd`, a `costSource` badge (priced, reported,
   unpriced) and its `how`.
4. **Tools and permissions**: `tools` (name, kind, calls, errors). Then `permissions.tools` (allowed, denied, and
   `sources` as chips), `permissions.modes`, `permissions.needsApproval` and `permissions.note`.
5. **Quality**: `evaluations` (name, count, average score, labels), `feedback` as 👍 and 👎, `approvals`.
6. **Value**: `value` as the agent card on the Value page, when it is not null.
7. **Activity**: `activity` as a list, when it has entries (Claude Code: commits, pull requests, lines, active time).
8. **Recent runs**: one row per `recentRuns` entry: time, status, duration, tokens, cost, and chips for retries,
   rate limits and loops. Tap opens the run. Hidden for an agent whose `runUnit` is not `run`.

### One run: `/agents/runs/:traceId`

Data: `GET /api/agents/runs/:traceId/graph`.

- **Summary strip**: duration, agents, model calls, tool calls, tokens, cost, errors, retries.
- **Loop banner**, when `loops` has entries: "`tool` was called `count` times in a row by `agent`".
- **The graph**:
  - Phone: a vertical tree. One row per node in the order returned, indented by `depth`, with a line to its parent.
  - From `md` up: the same nodes laid out left to right by depth, joined by `edges`.
  - A node shows an icon by `kind` (agent, subagent, model, tool, span), its `label`, its duration, and for a model
    its tokens and cost. An error node is red. `retry` and `loop` are small badges. `hiddenSpans` over 0 shows
    "+n spans".
  - Tap opens a sheet: every field of the node, `costHow`, `statusMessage`, and "Open in trace" to
    `/traces/:traceId` at that span.
- An "Open trace" button for the whole trace.

### Safety: `/agents/safety`

Data: `GET /api/agents/safety?from&to&service`.

- When `contentCaptured` is false: the `note`, and nothing else.
- Otherwise: three counters (`totals`), then one card per flag: kind, detector, the masked `sample`, the
  `attribute`, the agent and service, the time, and a link to the run. The `note` sits under the counters.
- Never fetch or show the unmasked content here.

### Settings: `/agents/settings` (admin)

- **Value**: hourly rate, currency, team attribute, loop threshold. `GET` and `PUT /api/value/settings`.
- **Prices**: `GET /api/value/prices`. One card per price: model, the four prices, `asOf`, `source` as a link, a
  "seeded" badge when `seeded`. Edit with `PUT /api/value/prices/:id`, add with `POST`, delete with `DELETE`. A
  `409` means the model already has a row.
- **Outcomes**: `GET /api/value/outcomes`. One card per outcome: name, the search, how it is credited, its value,
  `rationale`, an enabled switch, a "seeded" badge. The editor:
  - fields: name, description, signal (traces, logs, metric), query, attribution mode (and its field or agent),
    value kind (minutes or amount), minutes saved or amount, rationale, enabled
  - a live **preview** under the query: `POST /api/value/outcomes/preview` with the form and the page's period,
    showing matched, credited, unattributed, the unit value and the total. A `400` shows its message under the
    query.
  - save with `POST` or `PUT /api/value/outcomes/:id`; delete with `DELETE`
- **Restore the defaults**: `POST /api/value/seed`. It adds what is missing and leaves edited rows alone; show the
  counts it returns.

### Alerts page

Add "From a template" to the existing new-alert flow: `GET /api/agents/alert-templates` as a list grouped by `kind`
(cost, errors, quality), each with its title and description. Choosing one calls
`POST /api/agents/alert-templates/:key/install` and opens the new alert.

### The view app: three panel types

`apps/views` fetches a panel's data through the MCP tools, with the view's range as `from` and `to`:

- `agents` (`service?`): `list_agents`. Draw the agent cards of the Agents page, without filters.
- `agent_value` (`agent?`, `team?`, `service?`): `agent_value`. Draw the hero card and the agent cards. At `half`
  width, the hero card and the top three agents.
- `run_graph` (`traceId`): `run_graph`. Draw the vertical tree at any width.

The four tools are plain tools today. Once the view app draws their results, set `ui: true` on them in
`apps/api/src/agent-tools.ts` so a host that supports MCP Apps shows them as a view.

The dashboard editor needs the three types in its panel type list, with the fields above.

**Do this first, with the merge.** The three types are already in the `Panel` union, so two places stop
type-checking until they know them:

- `PANEL_TYPES` in `libs/ui/src/panels/panel-view.tsx` (a `Record<PanelType, …>`): add a label, an icon and a hint
  for `agents`, `agent_value` and `run_graph`.
- `newPanel` in `apps/console/src/components/dashboards/spec-ops.ts` (a `switch` with no default): add the three
  cases. `run_graph` starts with an empty `traceId`, like `trace`.

At run time nothing breaks before that: `PanelBody` already shows "This panel type isn’t supported here" for a type
it does not know.
