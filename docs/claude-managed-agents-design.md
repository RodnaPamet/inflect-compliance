inflect · claude managed agents · design v1 · 2026-10-24

# Claude Managed Agents in Inflect: hosted agents, and what hosting costs the tenant's data

> **Status: living design** — research into Claude Managed Agents and a
> recommendation for how, and how far, they enter Inflect's agent stack. None
> of it is built. The **Current state** section is true today. The **Roadmap**
> section is the plan, one pull request per step, and its later steps wait on
> owner decisions about data that no code can make. Companion documents:
> `docs/claude-agent-sdk-design.md` (the agent builder, and Route B: customer-
> run agents) and `docs/claude-tool-runner-design.md` (the builder's first
> engine). Facts were read on 2026-10-24 from the bundled Claude API reference
> and the live Managed Agents pages on platform.claude.com. Managed Agents is
> in beta (`managed-agents-2026-04-01`), so re-read the cited page before
> building any step. If the code contradicts a fact here, the code wins and the
> pull request that finds it corrects this document.

## The answer, briefly

Managed Agents is the only one of Anthropic's three agent offerings that hosts
the agent. Anthropic runs the loop, gives each session a container, stores the
agent as a versioned object and the session as an event history, and can fire
sessions on a cron schedule. Anthropic's own Console already lets a person
build one with no CLI. That makes it the obvious answer to "set up my own
agent without a CLI". It is also the one whose data terms fit Inflect worst:

- **No Zero Data Retention, and no HIPAA BAA.** The overview says Managed
  Agents "is not currently eligible for Zero Data Retention or HIPAA Business
  Associate Agreement (BAA) coverage", self-hosted sandboxes included.
- **Stored, and stored in the US.** Agent configurations (every version),
  full event histories (messages, tool inputs and tool results), files,
  memory and skills live at Anthropic. "Transcripts persist until you delete
  them." Workspace data residency is `us` only.
- **Agents cannot be deleted, only archived.** Every version of a system prompt
  stays.

Inflect is built for EU obligations (NIS2, the EU AI Act, GDPR), and its tool
results carry its customers' GRC data. So the recommendation is staged by how much data each shape
puts at Anthropic:

| Shape | What happens | Data at Anthropic, held by whom | Verdict |
| --- | --- | --- | --- |
| **MA-B. Connect an agent built in the Console** | The customer builds the agent in *their own* Anthropic Console. Inflect generates the MCP server entry and a bound key. Inflect governs it through `/api/mcp` | the customer's agent and transcripts, under the customer's own Anthropic contract | **Recommended**, after two fixes to `/api/mcp` (below). It shares the connect wizard with the Agent SDK's Route B |
| **MA-C2. Inflect provisions into the customer's workspace** | The customer connects an Anthropic workspace to Inflect. The agent builder provisions and runs Managed Agents there, with Inflect's tools as custom tools | as above, plus the tool results Inflect sends at the customer's direction | **Later.** Viable as a per-tenant integration, like GitHub or SharePoint |
| **MA-C1. Inflect hosts in its own Anthropic organisation** | The builder's agents run as Managed Agents in Inflect's organisation | every opted-in tenant's prompts and transcripts, stored by Inflect's sub-processor in the US, without ZDR | **Not recommended** until Anthropic offers ZDR or EU storage. It is a sub-processor change under the 30-day notice in any case |

## Current state (true today)

- **Anthropic is a sub-processor for Messages API calls only.**
  `docs/sub-processors.md` names it for the posture summary, risk suggestions and
  Flue agent runs, all sent with the deployment's own key. Nothing Inflect
  sends is stored as an agent, a session or a file at Anthropic.
- **`/api/mcp` is how external agents reach Inflect today.** Keys are
  `iflk_…`, bound to a registered agent, scoped `mcp:read` / `mcp:propose`. Every
  call goes through `authorizeToolCall`: kill switch first, then audience,
  credential, exposure, grants, policy card, autonomy ceiling, and the same
  permission check a human route uses.
- **Two gaps on that route matter for hosted callers.**
  - **Rate limit.** The `POST` handler takes the default mutation tier through
    `withApiErrorHandling`: 60 per minute, keyed by caller IP, with no actor
    (`docs/rate-limiting.md`). Every Managed Agent, from every customer, calls
    from Anthropic's egress addresses, so they would share one budget.
  - **AI Guard.** The route authorizes but runs no AI Guard on a read's
    arguments or result (`docs/claude-agent-sdk-design.md` → Route B, decision 6).
    Proposals are still guarded at the queue.
- **Integrations have a provider registry and a signed webhook route.**
  `src/app-layer/integrations/providers/` and
  `src/app/api/integrations/webhooks/[provider]/route.ts`. The route reads the
  raw body, resolves the tenant from the `IntegrationConnection` (never from the
  caller) and verifies the signature before it processes anything.
- **The tenant purge and DSAR flows reach only Inflect's own database.** No
  provider today holds tenant content that a purge would need to delete
  remotely.

## What Managed Agents is, as documented on 2026-10-24

**Objects.** All are workspace-scoped.

- **Agent** (`/v1/agents`). `name`, `model` (or
  `{ id, effort, speed, inference_geo }`), `system` (up to 100K characters),
  `tools`, `mcp_servers`, `skills`, `multiagent`, `metadata`. Every update is a
  new immutable version, and `version` gives optimistic concurrency. There is no
  delete; `archive` is permanent.
- **Environment** (`/v1/environments`). `cloud` with networking `unrestricted`
  or `limited` (`allowed_hosts`), or `self_hosted`.
- **Session** (`/v1/sessions`). It pins an agent version (or
  `agent_with_overrides`), plus `environment_id`, `resources`, `vault_ids` and
  `budget`. Statuses are `idle`, `running`, `rescheduling` and `terminated`.
  Stop reasons are `end_turn`, `requires_action`, `budget_reached` and
  `retries_exhausted`.
- **Events.** Sent with `POST …/events` and streamed from `GET …/events/stream`.
  The stream does not replay, so on every reconnect list `GET …/events` and
  dedupe by `id`, or a pending tool call deadlocks.

**Tools.**

- The built-in `agent_toolset_20260401` (bash, read, write, edit, glob, grep,
  web_fetch, web_search) can be left out entirely.
- **Custom tools** (`{ type: 'custom', name, description, input_schema }`) are
  executed by the client. The agent emits `agent.custom_tool_use`, the session
  idles with `requires_action`, and the client answers `user.custom_tool_result`
  (with `is_error` for a refusal). No timeout is documented, and idle time is
  not billed. Custom tools are not subject to permission policies.
- **MCP servers** are called from an Anthropic-side proxy, with credentials from
  a **vault** (`static_bearer`, `mcp_oauth`). Permission policies
  (`always_allow`, `always_ask`, `auto`) and `user.tool_confirmation` gate
  toolset and MCP calls.
- **Only custom tools leave every decision with Inflect.** With MCP, even
  `always_ask` ends with Anthropic making the call.

**Control.**

- `user.interrupt` stops the agent "at a safe boundary". Archive and delete are
  refused while a session is `running`. So a stop is: answer pending custom calls
  with `is_error`, interrupt, wait for idle, then delete.
- A session `budget` caps list-price dollars (tokens, web search and
  $0.08 per session-hour). It is checked before each model request, so it can
  overshoot by one request.
- `span.model_request_start` / `_end` events carry per-call token usage.
- The client sees `agent.message` text and every tool input. It does not see
  thinking, compaction summaries or the exact prompt of each call. Full
  per-call text is available only through API OpenTelemetry tracing in content
  mode.

**Scheduling.**

- Scheduled deployments (`/v1/deployments`, cron) fire sessions on their own.
  A fired session with custom tools waits until a client answers.
- Webhooks are registered **in the Console only**. They are HMAC-signed and
  thin, with at most three attempts and no ordering guarantee.

**Skills, memory and multi-agent.** Skills are uploaded per workspace
(`/v1/skills`, pinnable by version). Memory stores persist across sessions.
`multiagent` turns subagents and workflows **on** by default when present, so
leave it out entirely.

**Residency and platforms.**

- `inference_geo` is `us` or `global`. Workspace (storage) geography is `us`
  only.
- Managed Agents is available on the Claude API and Claude Platform on AWS
  (beta) and on Claude Models on Google Cloud (Anthropic managed). It is not
  available on Bedrock, Vertex or Foundry.
- Self-hosted sandboxes move only tool execution and the sandbox into the
  customer's infrastructure. The loop, transcript, skills and memory stay at
  Anthropic.

**Operations.**

- Rate limits are per organisation (300 creates and 1,200 reads per minute on
  the live reference page; the bundled reference differs).
- The default limit is 100 workspaces per organisation.
- The Admin API cannot create API keys.
- The Console session viewer shows every transcript to the organisation's
  Developers and Admins.

**Cost.** Tokens at list rates, plus $0.08 per session-hour while `running`,
plus a 1.1× multiplier for US-only inference.

**Naming.** The Managed Agents reference adds "Claude Cowork" to the names a
product may not use. The Agent SDK's naming rules apply too.

## How each shape would sit in Inflect

### MA-B: connect an agent the customer built in the Console

This is the Agent SDK's Route B with a different client, and it shares the wizard.

1. On a registered agent: **Connect an agent you run → Claude Managed Agent**.
   Inflect mints a bound key, as for Route B.
2. Inflect shows what to paste into the customer's Console:
   - the MCP server entry `{ type: 'url', name: 'inflect', url: '<origin>/api/mcp' }`;
   - the vault credential (`static_bearer` for that URL, holding the key);
   - the `mcp_toolset` configuration, with `default_config.permission_policy`
     set to `always_ask` for propose tools and an explicit tool list matching
     the agent's grants.

   No CLI on either side.
3. Inflect governs every call at `/api/mcp`, exactly as it governs any other key.

**Two prerequisites, both on `/api/mcp`:**

- **A per-key rate limit.** Key the route's tier by the authenticated
  credential (`apiKeyId`), not by IP. Otherwise one busy customer's hosted agent
  throttles every other customer's.
- **The AI Guard egress slice on arguments** (Agent SDK design, decision 6).

What Inflect cannot see in this shape: the agent's model calls. There is no
Art 12 row per model call and no token budget. Those belong to the customer's
deployment, as they do for any externally run agent today.

### MA-C2: the builder provisions into the customer's workspace

A new integration provider, `anthropic-workspace`, under
`src/app-layer/integrations/providers/`:

- **Credential.** A **workspace-scoped** Anthropic API key, encrypted like every
  other connection secret. The host is fixed (`api.anthropic.com`), so it is a
  `vendorOrigin` rule, never a typed URL. The Test button lists agents and
  changes nothing.
- **Provisioning.** Approving an agent profile version creates or updates *one*
  Managed Agent: `system` from the pinned instructions; `tools` as custom tools
  only (one per resolved tool, plus `activate_skill`); no `agent_toolset`, no
  `mcp_servers`, no `multiagent`, no memory. Inflect records the returned
  `{ id, version }` against the profile version.
- **Drift.** Before each session Inflect re-reads the agent at the pinned version
  and compares `system` and `tools` to what it wrote. A customer admin can edit
  the agent in their Console, so a mismatch refuses the run. Reporting drift
  between runs is an extension of the weekly integration-passport sweep, which
  today covers `mcp-server` connections only.
- **Environment.** `cloud`, `networking: limited` with no `allowed_hosts`. A
  profile that needs no sandbox never asks the agent to touch one.
- **The run** is a run driver, `managed-agents`, with the same admission as
  every other engine. A BullMQ job creates the session pinned to
  `{ id, version }` with a `budget` from the run caps, sends the first
  `user.message` and holds the stream:

| Inflect control | Mechanism |
| --- | --- |
| The funnel decides | `agent.custom_tool_use` → validate → `runGuardedTool` → `user.custom_tool_result` (`is_error` on refusal) |
| Kill switch | asked on every event the job handles. To stop: answer pending calls with `is_error`, send `user.interrupt`, wait for idle, delete. "At a safe boundary" is weaker than Inflect's own per-turn check; between tool calls the model can only write text |
| Run caps | tool calls and wall clock counted by the job; `budget` (dollars) as the backstop |
| `MODEL_CALL` + Art 12 | one per `span.model_request_end`, with its `model_usage`. The prompt of each call is not visible, so the decision row's input digest covers what Inflect sent, not what the model saw. This is weaker than the other engines, and the owner must accept it explicitly |
| Guard on model text | on `agent.message` text, *after* Anthropic has stored it |
| Skills | an Inflect `activate_skill` custom tool (pinned, hash-checked, no upload), or uploaded skills pinned by `version`. The custom tool keeps the mount gate in Inflect |
| Residency | `LOCAL_ONLY` is refused, with a named reason |
| Record and minimisation | the run's ledger is written in Inflect as it happens. At settle the job deletes the session (`DELETE /v1/sessions/{id}`), so the transcript does not outlive the run at Anthropic |
| Tenant purge, DSAR | the purge must reach the provider: delete every session, and archive the agents. Because an archived agent keeps its `system`, **instructions must carry no personal data**, which the builder's save-time scan must enforce for this engine |
| Long sessions | webhooks into `integrations/webhooks/[provider]` (`session.status_idled`) wake a job instead of holding a stream for hours. The customer registers the endpoint in their Console |

What MA-C2 adds over the Tool Runner engine is a **container**. A profile that
needs to parse a spreadsheet, run code or produce a `.docx` gets a sandbox
without Inflect running one. That is the only reason to choose it, and it
should stay the only reason: a profile that needs no container belongs on the
Tool Runner.

### MA-C1: Inflect's own organisation

Mechanically the same as MA-C2, with Inflect's key and one workspace per
residency class instead of per tenant (the 100-workspace default rules out
per-tenant). It changes what Inflect asks of Anthropic as a sub-processor:

- persistent storage of tenant agent instructions, which cannot be deleted;
- transcripts holding read-tool output, until Inflect deletes them;
- no ZDR, and US-only storage;
- Console visibility of those transcripts to Inflect's Developers and Admins;
- one rate limit shared by every tenant.

The current Anthropic row covers prompts sent through the Messages API. This is
materially new processing, so `docs/sub-processor-change-policy.md` applies in
full: 30 days' notice and a right to object. Whether EU customers' data may sit
at rest in the US without ZDR is a legal judgement, not an engineering one.

## Decisions for the owner

1. **MA-B now, MA-C2 later, MA-C1 not yet.** The staging above follows from
   who holds the data.
2. **Fix `/api/mcp` first.** A per-key rate limit and the argument guard. Both
   are worth doing for any external agent, and hosted callers make them urgent.
3. **For MA-C2, accept a weaker Art 12 row.** The per-call prompt is not visible
   to Inflect. The alternative is OpenTelemetry content-mode tracing from the
   customer's organisation, which means a second data path to secure.
4. **For MA-C2, delete sessions at settle.** This minimises what persists at
   Anthropic. It costs Anthropic's Console view of past runs, which Inflect's
   own run timeline replaces.
5. **Sub-processor framing for MA-C2.** Proposed: Anthropic acts as the
   customer's own processor, used at the customer's direction, listed as an
   opt-in per-tenant integration like GitHub and SharePoint. Confirm with
   whoever signs the sub-processor register.

## Roadmap (future direction)

1. **`/api/mcp` hardening** (shared with the Agent SDK's Route B): a per-credential
   rate-limit key, and the egress guard on arguments.
2. **Connect wizard, Managed Agents tab.** The generated MCP entry, vault
   instructions and tool list, beside the Agent SDK tab. Plus a short how-to in
   `docs/user/how-to/` for the help site.
3. **The `anthropic-workspace` integration provider.** Connection, encrypted
   key, Test, the passport entry, and the sub-processor row for the opt-in
   integration.
4. **The `managed-agents` driver.** Two-deploy enum; provisioning from an
   approved profile version; drift check; session job with reconnect and
   dedupe; the custom-tool bridge to the funnel; span-based ledger; delete at
   settle; conformance suite.
5. **Purge and DSAR reach.** `tenant-purge` deletes provider sessions and
   archives agents; the retention doc records what remains at Anthropic and why.
6. **Container-needing profiles.** Builder support for "this agent needs a
   workspace", which is the only path to the `managed-agents` engine. Gated on
   decision 1 being revisited with real demand.
