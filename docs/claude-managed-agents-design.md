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
  Managed Agent: `system` is Inflect's fixed preamble only; `tools` are custom
  tools only (one per resolved tool, plus `activate_skill`); no `agent_toolset`,
  no `mcp_servers`, no `multiagent`, no memory. Inflect records the returned
  `{ id, version }` against the profile version.
- **The tenant's instructions never go into the agent object.** An agent can be
  archived but not deleted, and every version of its `system` stays at Anthropic.
  So each session sends the pinned instructions through the session's own
  `agent_with_overrides` `system` override, and deleting the session at settle
  deletes them. Nothing a tenant wrote outlives the run at Anthropic. That makes
  a personal-data rule on instructions unnecessary here, which matters because
  the repository has no free-text personal-data detector to enforce one.
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
| Tenant purge, DSAR | the purge must reach the provider: delete every session Inflect created, and archive the agents. An archived agent keeps its `system`, which is why that holds Inflect's fixed preamble and never a tenant's instructions |
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

- transcripts holding tenant instructions and read-tool output, until Inflect
  deletes them (at settle, under the per-session design above);
- archived agent objects, which cannot be deleted, holding Inflect's fixed
  preamble and the tool schemas;
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

This document owns **Phases 5 and 6** of the plan for the three Claude agent
designs. How to use the plan, the phase map, the **global rules**, the
**definition of done** and the operational-evidence table are in the Roadmap of
`docs/claude-agent-sdk-design.md`. They bind every step here, and the prompts
point there rather than restating them.

Two items this document used to list as roadmap belong to other phases now:

- The `/api/mcp` per-key budget and argument guard are Step 0d, delivered by
  #4111.
- The connect wizard's Managed Agent tab (shape MA-B) is part of Step 3a.

| Step | Title | Depends on | Change class |
| --- | --- | --- | --- |
| 5a | The `anthropic-workspace` integration provider | 2H, 3H, owner decision 5 | Significant — new opt-in sub-processor integration, new egress host |
| 5b | Managed Agents driver, reader-only | 5a | Significant — enum value, new engine, schema migration |
| 5c | Purge and DSAR reach the provider | 5b | Significant — deletion path for data held by a third party |
| 5d | Turn the Managed Agents engine on | 5c deployed, owner decisions 3 and 4 | Significant — sends tenant data to the customer's processor |
| 5e | Profiles that need a workspace | 5d, owner decision 1 revisited | Significant — a sandbox for tenant agents |
| 5H | Phase 5 hardening | 5a–5e | Standard |
| 6a | Re-evaluate Anthropic's data terms, and give notice | 5H, a change in Anthropic's terms | Significant — sub-processor change |
| 6b | Host Managed Agents in Inflect's organisation | 6a's notice window closed | Significant — sub-processor activation |
| 6H | Phase 6 hardening | 6b | Standard |

**5c comes before 5d on purpose.** No tenant data reaches a provider until the
path that deletes it there is merged and deployed.

### Phase 5 — Managed Agents in the customer's workspace

For profiles that need a container. The builder provisions them as Managed Agents
in an Anthropic workspace the customer connects. Inflect's tools stay host-side
as custom tools, so every call still goes through the funnel.

#### Step 5a — The `anthropic-workspace` integration provider

**Goal.** A customer can connect their own Anthropic workspace to Inflect, with a
workspace-scoped key Inflect stores encrypted and can test without changing
anything.

```text
You are implementing Step 5a of the roadmap in
docs/claude-managed-agents-design.md. Read the global rules and definition of
done in the Roadmap of docs/claude-agent-sdk-design.md, then this document's
sections "What Managed Agents is" and "MA-C2: the builder provisions into the
customer's workspace", docs/new-subsystem-checklist.md, and an existing provider
end to end (src/app-layer/integrations/providers/legacy-mcp/ and the
integration config-schema origin rules). Phases 2 and 3 are merged.

Before starting, read "Decisions for the owner", decision 5, in this document. If
the owner has not confirmed how Anthropic is framed (the customer's own processor,
as an opt-in integration), stop and report: this step waits for that.

Goal: an anthropic-workspace provider that stores a workspace-scoped key and
tests it read-only.

1. Config: the workspace id (not a secret). Secret: the API key, encrypted like
   every connection secret. The host is fixed (api.anthropic.com) through a
   vendorOrigin rule, already one of ORIGIN_KINDS, and is never a typed URL.
2. validateConnection lists at most one agent in the workspace. It writes
   nothing and never calls markAuthFailure. Distinguish "the key is not
   workspace-scoped" from "the key is invalid", in plain words.
3. Every check in docs/new-subsystem-checklist.md, including the outcome metric
   and the two-tenant behavioural test.
4. An "Anthropic workspace" card on the integrations admin page, gated like the
   other connection cards, with copy that says what Inflect will create in the
   workspace (agents, one environment, sessions) and that it deletes sessions
   when each run ends.
5. docs/sub-processors.md: an opt-in per-tenant integration row, framed as the
   owner decided, in this diff.
6. Everything is behind a new opt-in env flag, AGENT_MANAGED_AGENTS. Triage it
   per global rule 6.

Tests: provider unit tests over a faux transport, for valid, invalid, wrong-scope
and unreachable; the two-tenant test; a rendered test for the card; one E2E spec
on isolatedTenant that connects with a faux endpoint in E2E mode.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The key is in the encryption manifest path for connection secrets, and a raw read returns ciphertext (integration test).
- [ ] The Test button writes no row and never marks the connection failed (test asserts both).
- [ ] The host cannot be changed by configuration. A config naming another host is refused at save, proven by a test.
- [ ] Every item of `docs/new-subsystem-checklist.md` is ticked with its test.
- [ ] The sub-processor row changes in this diff and matches the owner's framing word for word.
- [ ] With `AGENT_MANAGED_AGENTS` unset, the card does not render and the provider is not registered.

**Exit.** A customer can connect an Anthropic workspace and test it, and Inflect has created nothing in it.

#### Step 5b — Managed Agents driver, reader-only

**Goal.** Build the whole engine behind `DRIVER_IMPLEMENTED = false`. It covers
provisioning, the drift check, the session job and the custom-tool bridge, and
ships the `MANAGED_AGENTS` enum value with no writer.

```text
You are implementing Step 5b of the roadmap in
docs/claude-managed-agents-design.md. Read the global rules and definition of
done in the Roadmap of docs/claude-agent-sdk-design.md, then all of "MA-C2" in
this document. Use the claude-api skill (Managed Agents reading guide, client
patterns, events) and check every SDK binding against the live documentation and
the installed @anthropic-ai/sdk before using it. Read the Step 0b conformance
suite and the Tool Runner driver (src/lib/agentic/tool-runner/). Step 5a is
merged.

Goal: a managed-agents driver that passes the conformance suite and that the
gate cannot select yet.

1. Add 'managed-agents' to AGENT_DRIVERS, classify it in isReasoningEngine, set
   DRIVER_IMPLEMENTED false, and add MANAGED_AGENTS to AgentDriverMode as a
   reader-only value.
2. Provisioning, on approval of a profile version in a tenant whose engine
   setting and connection allow it:
   - create or update one Managed Agent with system = Inflect's fixed preamble
     only, tools = custom tools only, and no agent_toolset, mcp_servers,
     multiagent or memory;
   - create one environment per connection: cloud, networking limited, no
     allowed_hosts;
   - record {agentId, version, systemHash, toolsHash} in a new table,
     AgentProfileProvision. Follow global rule 7.
   The tenant's instructions are NOT written into the agent.
3. The session job, one BullMQ job per run, with the run's caps:
   a. Drift check: read the agent at the pinned version, compare the hashes,
      and refuse AGENT_DRIFTED before the session exists.
   b. Create the session with agent { type: 'agent_with_overrides', id,
      version, system: preamble + the pinned instructions }, the
      environment_id, a dollar budget derived from the run's token cap at the
      tier's list price as a backstop, and metadata naming the tenant and the
      run.
   c. Stream the events. On each agent.custom_tool_use: check the kill switch,
      validate the arguments, call runGuardedTool, charge the budget, write
      TOOL_CALL, answer user.custom_tool_result (is_error on refusal). On each
      span.model_request_end: write MODEL_CALL and an AiDecisionLog row marked
      as span-derived, whose input digest covers what Inflect sent. On each
      agent.message: guardEgress on the text.
   d. On a dropped stream: list events, dedupe by id, then resume. A pending
      custom tool call must never deadlock.
   e. Stop (kill, cap, guard, wall clock): answer pending calls with is_error,
      send user.interrupt, wait for idle, delete the session.
   f. Settle: delete the session in finally, and record the deletion in the
      ledger.
4. The client is built per run from the connection's decrypted key, with the
   workspace header. No other module constructs a client for this engine (guard).
5. Pass the conformance suite against a faux SSE transport. Two shared
   scenarios cannot hold as written for this engine, because Anthropic stops a
   session at a safe boundary and does not show Inflect each call's prompt:
   - the kill switch: assert the strongest property available instead, which
     is that no tool executes after the switch engages and the session is
     deleted;
   - the decision-row digest: assert it covers what Inflect sent.
   Express each as a variance the engine's adapter declares, and never by
   weakening the shared scenario. List both in the pull request for the owner,
   citing decision 3.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The conformance suite passes, and every scenario is mutation-proved against this driver. The two declared variances are listed in the pull request, and the shared scenarios are unchanged.
- [ ] The tenant's instructions are never in an `agents.create` or `agents.update` body, asserted on the faux transport, and only in the session's override.
- [ ] Every session the job creates is deleted, on completion, on every stop condition and on a thrown error (one test per path).
- [ ] A dropped stream with a pending custom tool call resumes and answers it exactly once (test).
- [ ] Drift in `system` or `tools` refuses the run before a session exists.
- [ ] Each `span.model_request_end` produces exactly one `MODEL_CALL` and one decision row marked span-derived.
- [ ] With `DRIVER_IMPLEMENTED` false, no input selects this engine, and a stored `MANAGED_AGENTS` reads as that mode while no writer accepts it.
- [ ] The rollback plan and risk assessment are in the pull request.

**Exit.** The engine exists, is conformance-proven, deletes everything it creates per run, and cannot run.

#### Step 5c — Purge and DSAR reach the provider

**Goal.** Before any tenant data reaches a workspace, make deleting a tenant, or
disconnecting its workspace, delete what Inflect created there.

```text
You are implementing Step 5c of the roadmap in
docs/claude-managed-agents-design.md. Read the global rules and definition of
done in the Roadmap of docs/claude-agent-sdk-design.md, this document's table row
"Tenant purge, DSAR", the "Data Retention" section of CLAUDE.md,
docs/data-retention.md, and src/app-layer/usecases/tenant-purge.ts. Step 5b is
merged.

Goal: what Inflect created in a customer's workspace is removed when the tenant is
purged or the connection is removed, and the retention document says exactly
what remains.

1. On tenant purge (tenant-purge.ts) and on removal of an anthropic-workspace
   connection:
   - delete every session Inflect recorded for that connection, including any
     a crash left behind;
   - archive every agent recorded in AgentProfileProvision (agents cannot be
     deleted).
   Use recorded ids only, never a list-and-match over the customer's workspace:
   Inflect deletes what it created and nothing else.
2. A provider that cannot be reached does not block the rest of the purge. The
   remote clean-up is recorded with a named outcome and retried by the existing
   data-lifecycle job until it succeeds. It is never reported done when it is not.
3. docs/data-retention.md records what remains at Anthropic after a purge (the
   archived agent objects with Inflect's preamble and tool schemas, and nothing
   tenant-authored) and why.
4. A periodic reconciliation lists sessions Inflect recorded as deleted but which
   still exist (a lost delete), deletes them, and emits a metric.

Tests: purge over a faux transport deletes exactly the recorded sessions and
archives exactly the recorded agents; an unreachable provider leaves a retryable
record; disconnecting a workspace triggers the same clean-up.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The clean-up touches only recorded ids. A test with a foreign session in the faux workspace proves it is left alone.
- [ ] An unreachable provider never marks the clean-up done, and the retry succeeds once it is reachable (test).
- [ ] `docs/data-retention.md` and `tenant-purge-retained-never-cascades` agree with the new table's retention class.
- [ ] The reconciliation deletes a lost session and emits its metric (test).

**Exit.** Anything Inflect creates in a customer's workspace can be removed, and is removed when the tenant or the connection goes.

#### Step 5d — Turn the Managed Agents engine on

**Goal.** One deploy after 5c, let a tenant with a connected workspace run a profile
on this engine.

```text
You are implementing Step 5d of the roadmap in
docs/claude-managed-agents-design.md. Read the global rules and definition of
done in the Roadmap of docs/claude-agent-sdk-design.md, and "Decisions for the
owner" in this document. Steps 5b and 5c are merged AND deployed to production.
Before writing the enum value anywhere, confirm that the deployed image carries
it.

Before starting, confirm that decisions 3 (accept a weaker Art 12 row) and 4
(delete sessions at settle) are recorded as accepted. If either is not, stop and
report.

Goal: DRIVER_IMPLEMENTED['managed-agents'] is true; the engine settings page
offers it only to a tenant with a connected workspace; the builder's Test run
works on it.

1. Flip the flag in its own commit.
2. setAgentDriverSetting and the PUT schema accept MANAGED_AGENTS. A tenant
   without a connected workspace is refused with a named reason. The settings
   page explains the engine in plain words, including that conversations exist
   in the customer's workspace until each run ends.
3. The run timeline marks span-derived decision rows, so a reviewer can see that
   the per-call prompt was not visible to Inflect.

Tests: an E2E spec on isolatedTenant with a faux workspace that connects,
selects the engine and completes a Test run, then asserts the faux workspace
holds no session.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The flag flip is its own commit, and the deployed image was confirmed before merge.
- [ ] A tenant without a connected workspace cannot select the engine (test).
- [ ] After the E2E run the faux workspace holds no session.
- [ ] Span-derived decision rows are labelled in the run timeline (rendered test).

**Exit.** A tenant can run a profile in its own Anthropic workspace, and nothing tenant-authored stays there after the run.

#### Step 5e — Profiles that need a workspace

**Goal.** Let a profile ask for a container (to run code or produce a file), and
make that the only route onto the Managed Agents engine.

```text
You are implementing Step 5e of the roadmap in
docs/claude-managed-agents-design.md. Read the global rules and definition of
done in the Roadmap of docs/claude-agent-sdk-design.md, and the closing paragraph
of "MA-C2". Step 5d is merged.

Before starting, confirm that the owner has revisited decision 1 with a real
profile that needs a container, and recorded it. If not, stop and report: this
step has no trigger.

Goal: a profile option "This agent needs a workspace". A profile with it runs on
the Managed Agents engine with the agent toolset enabled inside a container with
no network. A profile without it never does.

1. AgentProfileVersion gains needsWorkspace (additive, default false). The
   builder shows it with a sentence on what it means.
2. A needsWorkspace profile provisions an agent whose toolset enables only what
   the owner approved (for example read, write and bash), in an environment
   with networking limited and no allowed_hosts. No web tools, ever.
3. Files the session produces return to Inflect only through the existing
   evidence upload path (size limits, AV scan), attached to the run. They are
   never served straight from the provider.
4. Engine selection: a needsWorkspace profile refuses on every other engine, and
   a profile without it refuses on this one. Both carry named reasons.

Tests: provisioning bodies for both kinds of profile; the refusal matrix; an
output file passes the AV path before it is visible.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The toolset in the provisioning body equals the owner-approved list exactly, and contains no `web_fetch` or `web_search` (test).
- [ ] The environment has no `allowed_hosts` (test).
- [ ] An output file is not visible to any user until the AV scan passes (test).
- [ ] The refusal matrix is complete over both profile kinds and every engine.

**Exit.** A profile that needs a container gets one, in the customer's workspace, with no network. Nothing else does.

#### Step 5H — Phase 5 hardening

**Goal.** Prove in a real workspace that the engine keeps Inflect's controls in
front of it, and leaves nothing behind.

```text
You are implementing Step 5H of the roadmap in
docs/claude-managed-agents-design.md: the hardening step for Phase 5. Steps
5a–5e are merged. Read the global rules, definition of done and "Operational
evidence" in the Roadmap of docs/claude-agent-sdk-design.md, and all of Phase 5
here.

Goal: evidence from a real Anthropic workspace.

1. Adversarial read of 5a–5e together. At least:
   - Can a tenant's instructions reach the agent object through any path,
     including an update?
   - Can a session survive a worker restart undeleted?
   - Can a custom tool result be sent twice?
   - Can a customer admin's Console edit widen what a run reaches?
   - Can the dollar budget be exceeded by more than one request?
   Fix what you find, each with a test.
2. The owner connects a real Anthropic workspace to the proving tenant. Run an
   approved profile, then run it again with the kill switch engaged mid-run.
   Record:
   - the run ids, the MODEL_CALL and TOOL_CALL counts, and the halt reason;
   - that the workspace holds no session afterwards, checked through the
     provider's list endpoint, with ids only.
3. Edit the provisioned agent's system prompt in the Console, run again, and
   record the AGENT_DRIFTED refusal.
4. Purge rehearsal: disconnect the workspace, and record that the recorded
   agents are archived and no session remains.
5. Update this document's Current state, the evidence row in the Agent SDK
   document, and CLAUDE.md's "Claude agent engines" section.

Deliver per the Definition of done.
```

**Hardening**

- [ ] Each adversarial question is answered in the implementation note, with a test for each defect found.
- [ ] A production run in a real workspace completed, and the workspace held no session afterwards (recorded by method and date).
- [ ] The kill-switch drill and the drift refusal were observed for real, by run id.
- [ ] The disconnect rehearsal archived the recorded agents and left no session.
- [ ] The evidence row is filled from production, not from a test.

**Exit.** Managed Agents has run in a real customer-shaped workspace under every Inflect control, and left nothing tenant-authored behind.

### Phase 6 — Managed Agents hosted by Inflect

**Blocked** until Anthropic offers Zero Data Retention or EU storage for Managed
Agents. Every prompt in this phase begins by checking that, and stops when it is
not true.

#### Step 6a — Re-evaluate Anthropic's data terms, and give notice

**Goal.** Establish from primary sources whether hosting is now acceptable. If it is,
start the sub-processor change with its 30-day notice.

```text
You are implementing Step 6a of the roadmap in
docs/claude-managed-agents-design.md. Read the global rules and definition of
done in the Roadmap of docs/claude-agent-sdk-design.md, this document's sections
"The answer, briefly" and "MA-C1", docs/sub-processors.md and
docs/sub-processor-change-policy.md. Phase 5 is merged.

1. Read Anthropic's live Managed Agents overview, data-retention and data-residency
   pages. Quote what they say today about Zero Data Retention, workspace
   geography and deletion of agents. If neither ZDR nor EU storage is offered,
   stop. Record the check and its date in the Phase 6 evidence row, and change
   nothing else.
2. If the terms have changed, update the MA-C1 section with the new facts, and
   prepare the sub-processor change: the docs/sub-processors.md row describing
   the new processing (stored transcripts until deletion, archived agent objects,
   Console visibility, a shared rate limit), and the customer notice text.
3. Nothing in src/ changes in this step. Activation is 6b, after the window
   closes.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] Every fact about Anthropic's terms is quoted from a live page, with its URL and date.
- [ ] If the terms have not changed, the only diff is the evidence row.
- [ ] If they have, the sub-processor row and notice follow `docs/sub-processor-change-policy.md` step by step, and approval is recorded on the pull request.

**Exit.** Either the block is reconfirmed with a dated source, or the 30-day notice has started.

#### Step 6b — Host Managed Agents in Inflect's organisation

**Goal.** After the notice window closes with no sustained objection, let a tenant
without its own Anthropic workspace use the Managed Agents engine in Inflect's
organisation.

```text
You are implementing Step 6b of the roadmap in
docs/claude-managed-agents-design.md. Read the global rules and definition of
done in the Roadmap of docs/claude-agent-sdk-design.md, and all of "MA-C1".
Before starting, confirm from the 6a pull request that the notice window has
closed with no sustained objection, and that the owner has recorded the
activation. If either is not true, stop.

Goal: the managed-agents engine can run in Inflect's own organisation, in one
workspace per residency class, for tenants that opt in.

1. Workspaces are per residency class, never per tenant (the default limit is 100
   workspaces per organisation). The deployment's keys for each are environment
   configuration, triaged per global rule 6.
2. A tenant opts in with a setting that only admin.tenant_lifecycle can change,
   and that names the processing in plain words.
3. Everything from Phase 5 applies unchanged: per-session instructions, delete at
   settle, the purge path, the drift check. Rate limits are shared across tenants
   in one organisation, so add a per-tenant concurrency cap on this engine.

Tests: the engine resolves the organisation's workspace for an opted-in tenant
with no connection, and refuses for a tenant that has not opted in; the
per-tenant cap holds under concurrent runs.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The pull request links 6a and shows the notice window closed.
- [ ] A tenant that has not opted in cannot reach the organisation's workspace (test).
- [ ] The per-tenant concurrency cap holds (test), and a burst from one tenant cannot exhaust the organisation's limit for the others.
- [ ] The Phase 6 evidence row is filled from the first production run.

**Exit.** Tenants that opt in can use hosted agents without an Anthropic account of their own, under the terms they were notified of.

#### Step 6H — Phase 6 hardening

**Goal.** Prove that tenants sharing one of Inflect's workspaces cannot reach each
other's runs, and that hosting holds to the terms customers were notified of.

```text
You are implementing Step 6H of the roadmap in
docs/claude-managed-agents-design.md: the hardening step for Phase 6. Steps 6a
and 6b are merged and the engine has run in production. Read the global rules,
definition of done and "Operational evidence" in the Roadmap of
docs/claude-agent-sdk-design.md, and all of Phases 5 and 6 here.

Goal: evidence that a shared workspace keeps tenants apart, and that what is
stored at Anthropic matches the notice.

1. Adversarial read of 6a and 6b together, for what sharing a workspace adds:
   - Can one tenant's job read, answer or delete another tenant's session in the
     same workspace?
   - Are sessions selected only by recorded id, never by listing?
   - Can a tenant's burst exhaust the organisation's rate limit for the others?
   - Who in Inflect's organisation can see transcripts in the Console, and is
     that what the notice said?
   Fix what you find, each with a test.
2. A two-tenant production check. Two opted-in proving tenants run at the same
   time in the same workspace. Record:
   - each run's session id, from their own ledgers;
   - that neither job touched the other's session, from the provider's request
     log or Inflect's ledger, ids only;
   - that both workspaces were empty of sessions afterwards.
3. Compare what is stored at Anthropic after a week of runs (archived agents,
   any surviving sessions) with the 6a notice. Record any difference, and treat
   a difference as a defect.
4. Update this document's Current state, the Phase 6 evidence row, and CLAUDE.md.

Deliver per the Definition of done.
```

**Hardening**

- [ ] Each adversarial question is answered in the implementation note, with a test for each defect found.
- [ ] The two-tenant production check shows no cross-tenant session access, recorded by ids.
- [ ] What remains at Anthropic matches the 6a notice, or the difference is fixed in this pull request.
- [ ] Console transcript visibility in Inflect's organisation matches what the notice said, with the role names recorded.

**Exit.** Hosted agents run for several tenants in one organisation without crossing between them, and store only what customers were told.
