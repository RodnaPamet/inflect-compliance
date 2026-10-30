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
| **MA-B. Connect an agent built in the Console** | The customer builds the agent in *their own* Anthropic Console. Inflect generates the MCP server entry and a bound key. Inflect governs it through `/api/mcp` | the customer's agent and transcripts, under the customer's own Anthropic contract | **Recommended.** Its two prerequisites on `/api/mcp` are met (#4111). It shares the connect wizard with the Agent SDK's Route B |
| **MA-C2. Inflect provisions into the customer's workspace** | The customer connects an Anthropic workspace to Inflect. The agent builder provisions and runs Managed Agents there, with Inflect's tools as custom tools | as above, plus the tool results Inflect sends at the customer's direction | **Later.** Viable as a per-tenant integration, like GitHub or SharePoint |
| **MA-C1. Inflect hosts in its own Anthropic organisation** | The builder's agents run as Managed Agents in Inflect's organisation | every opted-in tenant's prompts and transcripts, stored by Inflect's sub-processor in the US, without ZDR | **Planned** (owner decision, 2026-10-24), for tenants with no Anthropic account of their own. It does not wait for ZDR or EU storage. It is a sub-processor change, so it starts only 30 days after customers are notified, and only for a tenant that opts in knowing where its data goes |

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
- **The route is ready for hosted callers (#4111).** Two gaps that mattered
  for them are closed:
  - **Rate limit.** Each verified API key has its own budget, 60 JSON-RPC
    messages a minute (`MCP_PER_KEY_LIMIT`), charged per message. A per-IP
    ceiling of 600 requests a minute sits in front of authentication. Every
    Managed Agent calls from Anthropic's egress addresses, and they no longer
    share one budget (`docs/rate-limiting.md`, "The MCP endpoint").
    - **The key is charged before any work** (#4210). It is charged after the
      cheap credential check and before the registration gate and the
      invocation, whose `tools/list` reaches every external connection. A
      malformed request costs one unit.
  - **AI Guard.** A read tool's arguments pass the same egress scan that
    `runGuardedTool` applies to Inflect's own engines
    (`src/lib/mcp/argument-guard.ts`).
    - **The scan runs after the gate** (#4210). It runs once the tool has
      resolved and passed `authorizeToolCall`, so an unknown or unauthorized
      call is refused as such and writes no guard row. A refusal names no rule.
    - **What the scan reads** (#4212). It reads keys as well as values, and
      refuses content nested past depth 64 rather than passing it as clean.
    - **Proposals** are guarded at the queue, as before.
    - **A read's *result*** is not scanned on this route, because the model
      that consumes it is not Inflect's.
- **Every engine plugs into one tool core and passes one conformance suite**
  (Phase 0 of `docs/claude-agent-sdk-design.md`).
  - **The tool core** (`src/lib/agentic/engine-tools/`) holds the narrowing, the
    review latch and the guarded call. An engine supplies only its tool shape
    and its guard source prefix.
  - **The conformance suite** (`tests/helpers/driver-conformance.ts`) holds
    every run driver to the same controls. The kill switch and the caps are
    asked before every model call, and an unvouched agent is refused before
    its run row exists.
  - **A new run driver must pass it before it is switched on.** That includes
    the managed-agents driver this document plans. A variance is allowed only
    with a named owner decision.
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

**Its two prerequisites on `/api/mcp` are met (#4111):**

- **A per-key rate limit.** The route's budget is keyed by the verified
  `apiKeyId`, not by IP, so one busy customer's hosted agent cannot throttle
  another customer's.
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

For a tenant that wants a hosted agent and has no Anthropic account of its own.
The owner decided on 2026-10-24 that Inflect offers this, and that it does not
wait for Anthropic to offer ZDR or EU storage.

Mechanically it is MA-C2 with Inflect's key. It uses one workspace per
deployment, production and staging, shared by every tenant that opts in, never
one per tenant (the 100-workspace default rules that out). Sharing a workspace
adds four rules that MA-C2 does not need:

- **Addressed by recorded id only.** Sessions and agents are read, answered,
  interrupted, deleted and archived by the ids Inflect recorded, never found by
  listing the workspace. Agent names and session metadata carry opaque ids, never
  a tenant's name or slug or a profile's name. Archived agents cannot be
  deleted, so they must say nothing about a tenant.
- **One organisation's rate limits, shared.** Anthropic's limits are per
  organisation. So there is a per-tenant concurrency cap, and a deployment-wide
  cap below the organisation's limit. One tenant's burst must not stop another
  tenant's runs.
- **Inflect pays.** Session time ($0.08 per session-hour) and tokens are billed
  to Inflect. Usage is recorded per tenant, and hosted runs sit behind a billing
  entitlement.
- **A tenant's own workspace wins.** A tenant that has connected its own
  workspace (MA-C2) always runs there. A tenant whose AI residency is
  `LOCAL_ONLY` is refused, because the only storage on offer is in the US.

It changes what Inflect asks of Anthropic as a sub-processor:

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
at rest in the US without ZDR is a legal judgement, not an engineering one. The
owner's decision to host does not make it. It is recorded under decision 6,
before any notice goes out.

**The order is fixed by that policy, not by the build.** The notice (Step 6a)
can go out once the driver exists, because the policy wants a concrete codebase
cross-reference before any customer-facing notice. The hosted path is then built
during the 30-day window (6b), behind a source constant that is false. It is
switched on (6c) only after the window closes with no sustained objection. This
is the pattern `TYPESAFE_SUBPROCESSOR_ACTIVE` already follows: code may exist
before the window closes, but tenant data may not reach the new processing.

## Decisions for the owner

1. **MA-B now, then MA-C2 and MA-C1 once the engine is built.** The staging
   follows from who holds the data. **Decided for MA-C1 on 2026-10-24:** it is
   in scope, and it no longer waits for Anthropic to offer ZDR or EU storage.
   What it still waits for is decision 6 and the 30-day notice.
2. **Fix `/api/mcp` first.** A per-key rate limit and the argument guard. Both
   are worth doing for any external agent, and hosted callers made them urgent.
   **Done in #4111.**
3. **For MA-C2, accept a weaker Art 12 row.** The per-call prompt is not visible
   to Inflect. The alternative is OpenTelemetry content-mode tracing from the
   customer's organisation, which means a second data path to secure.
4. **For MA-C2, delete sessions at settle.** This minimises what persists at
   Anthropic. It costs Anthropic's Console view of past runs, which Inflect's
   own run timeline replaces.
5. **Sub-processor framing for MA-C2.** Anthropic acts as the customer's own
   processor, used at the customer's direction, listed as an opt-in per-tenant
   integration like GitHub and SharePoint. **Confirmed by the owner on
   2026-10-30, as proposed.** Step 5a writes the `docs/sub-processors.md` row
   in these words.
6. **Transfer basis for MA-C1.** For tenants that opt in, Anthropic stores
   session data as Inflect's own sub-processor, in the US, without ZDR. Before
   the 6a notice goes out, someone must record three things on its pull request,
   per *Sub-processors: who confirms which half of step 2* in
   `docs/change-management-policy.md`:
   - the transfer mechanism for EU personal data (SCCs, or the basis Anthropic's
     DPA gives);
   - whether a transfer impact assessment is obtained;
   - if one is not, who accepted proceeding without it.

   The owner's decision to host is a product decision, and it does not answer
   these.

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
| 6a | The sub-processor change and the customer notice | 5b, owner decision 6 | Significant — sub-processor change |
| 6b | The hosted path, behind a constant that is false | 5d, 6a | Significant — new deployment credential, schema migration |
| 6c | Switch hosting on | 6b deployed, 6a's notice window closed | Significant — sub-processor activation |
| 6H | Phase 6 hardening | 6c, 5H | Standard |

**5c comes before 5d on purpose.** No tenant data reaches a provider until the
path that deletes it there is merged and deployed.

**6a runs beside Phase 5, not after it.** The notice needs only the driver to
exist (5b). After that, the 30-day window runs while 5c, 5d and 6b are built.
Phase 6 then waits on the calendar, not on Phase 5's hardening.

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

**Planned** (owner decision, 2026-10-24). Phase 6 does not wait for ZDR or EU
storage. It waits for `docs/sub-processor-change-policy.md`: no tenant's data
reaches Inflect's organisation until 30 days after customers are notified, and
then only for a tenant that opts in. The notice (6a) goes out once the driver
exists. The hosted path is built during the window (6b), behind a constant that
is false. Activation (6c) is the diff that sets it true.

#### Step 6a — The sub-processor change and the customer notice

**Goal.** Propose, approve and announce the new processing, so the 30-day window
runs while the hosted path is built.

```text
You are implementing Step 6a of the roadmap in
docs/claude-managed-agents-design.md. Read the global rules and definition of
done in the Roadmap of docs/claude-agent-sdk-design.md, this document's sections
"The answer, briefly" and "MA-C1", "Decisions for the owner" (decisions 1 and
6), docs/sub-processors.md, docs/sub-processor-change-policy.md, the section
"Sub-processors: who confirms which half of step 2" in
docs/change-management-policy.md, and §7 of
docs/data-processing-agreement-template.md. Step 5b is merged.

Before starting, confirm that decision 6 is recorded: the transfer mechanism,
whether a transfer impact assessment is obtained, and, if not, who accepted
proceeding without one. If it is not recorded, stop and report. A notice
cannot describe a transfer basis that nobody has confirmed.

Goal: the change to Anthropic's processing is in the sub-processor register,
approved, and noticed. Nothing in src/ changes.

1. Re-read Anthropic's live Managed Agents overview, data-retention and
   data-residency pages. Quote what each says today about Zero Data Retention,
   workspace geography, how long sessions are kept, and deleting agents.
   - If a term is now better than "MA-C1" records (ZDR, EU storage, agents that
     can be deleted), update the section, and describe the better term in the
     notice.
   - If a term is worse, stop and report.
2. Edit Anthropic's row and detail subsection in docs/sub-processors.md for the
   new processing. Cover:
   - session event histories (the tenant's instructions, tool inputs, read-tool
     results), kept until Inflect deletes the session when the run ends;
   - archived agent objects holding Inflect's fixed preamble and tool schemas,
     which cannot be deleted;
   - who can see transcripts in the Console: Inflect's organisation members in
     named roles;
   - region: US;
   - operator-optional, and per tenant: only a tenant that opts in;
   - a codebase cross-reference to the 5b driver.
3. Write the customer notice, one page in plain words. It says:
   - what is stored, where, and for how long;
   - who at Inflect can see it;
   - that nothing is stored for a tenant that does not opt in;
   - how to object.
   Put the draft in the pull request for approval. It is posted to the public
   sub-processor list and emailed to each customer's primary contact, as the
   policy requires.
4. Record on the pull request:
   - compliance approval (step 2 of the policy);
   - the transfer mechanism;
   - the date the notice went out, and the date the window closes 30 days later.
   Copy both dates into the MA-C1 section.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] Every fact about Anthropic's terms is quoted from a live page, with its URL and the date read.
- [ ] The register row names the data, purpose, region, opt-in scope and codebase cross-reference that step 1 of the policy requires.
- [ ] The approval, the transfer mechanism and the decision on a transfer impact assessment are recorded on the pull request, each naming a person.
- [ ] The notice describes no processing that 5b's driver does not perform, and leaves out none that it does.
- [ ] No file under `src/` changes.

**Exit.** The 30-day window is running, against a description that matches the code.

#### Step 6b — The hosted path, behind a constant that is false

**Goal.** Build everything hosting needs, so that 6c is a one-line diff. Tenant data
must not reach Inflect's organisation in this step.

```text
You are implementing Step 6b of the roadmap in
docs/claude-managed-agents-design.md. Read the global rules and definition of
done in the Roadmap of docs/claude-agent-sdk-design.md, all of "MA-C1" and
Phase 5 in this document, and how TYPESAFE_SUBPROCESSOR_ACTIVE gates a
sub-processor in src/lib/legacy-access/adjudication-mode.ts and
tests/guards/ai-residency-enforcement.test.ts. Steps 5d and 6a are merged. The
notice window may still be open.

Goal: the managed-agents engine can resolve Inflect's own workspace for a tenant
that opted in, but cannot do so yet.

1. HOSTED_MANAGED_AGENTS_ACTIVE: a plain source constant, false. Setting it
   true is the sub-processor activation (6c), a reviewed diff. It is never an
   environment variable or a tenant setting. While it is false, the engine
   resolves no hosted workspace for any tenant, and the client factory returns
   before it constructs a client with Inflect's key.
2. Deployment configuration: Inflect's workspace id and key, one pair per
   deployment, with production and staging never shared. Add them through
   src/env.ts per global rule 6. A deployment without them never offers
   hosting, which is the self-hosted case.
3. Tenant opt-in:
   - a column on TenantSecuritySettings;
   - written only by a usecase behind a literal
     requirePermission('admin.tenant_lifecycle'), by a person (refuse an API
     key, an agent and a job), and audited;
   - the settings text says, in plain words, that conversations run in Inflect's
     Anthropic organisation and are stored in the US without Zero Data
     Retention until each run ends, and that agent objects holding only
     Inflect's own instructions and tool schemas are archived and never deleted;
   - opting out runs 5c's clean-up for that tenant.
4. Workspace resolution, in one function:
   - the tenant's own connected workspace wins;
   - otherwise Inflect's workspace, when all four hold: the constant is true,
     the deployment is configured, the tenant opted in, and the tenant's AI
     residency is not LOCAL_ONLY;
   - otherwise refuse, with a reason that names which one failed.
   The run ledger records which workspace a run used.
5. Sharing a workspace:
   - sessions and agents are addressed only by recorded id, never by listing;
   - agent names and session metadata carry opaque ids only, never a tenant
     name or slug or a profile name.
6. Capacity: Anthropic's rate limits belong to Inflect's organisation. Add a
   per-tenant concurrency cap on this engine, and a deployment-wide cap below
   the organisation's limit. A run over a cap waits or refuses with a named
   reason.
7. Cost: Inflect pays for these sessions. Record each run's usage per tenant,
   and gate hosted runs with an entitlement in src/lib/billing/entitlements.ts.

Tests:
- With the constant false, no input resolves the hosted workspace, and no
  client with Inflect's key is built. Assert this on the factory, not on the
  setting, and pin the order in a source-reading guard.
- With the constant true in the test, the resolution matrix: own connection,
  opt-in, residency, deployment configuration.
- The opt-in writer refuses ADMIN, an API key, an agent and a job.
- Both caps hold under concurrent runs.
- Purge and opt-out archive and delete only the tenant's recorded ids. Another
  tenant's session in the same faux workspace is left alone.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] With the constant false, the factory returns before it constructs a client, pinned by a guard that reads the source for the order.
- [ ] The opt-in writer is OWNER-only, person-only and audited (tests).
- [ ] The resolution matrix is complete, including the `LOCAL_ONLY` refusal and a deployment without Inflect's key.
- [ ] Nothing tenant-authored appears in an `agents.create` or `agents.update` body, or in any agent name or metadata, asserted on the faux transport.
- [ ] Clean-up in a shared workspace touches only that tenant's recorded ids (test with a second tenant's session present).
- [ ] Both caps hold, and one tenant's burst leaves capacity for another (test).
- [ ] The rollback plan and risk assessment are in the pull request.

**Exit.** The hosted path is built and proven, and it cannot run.

#### Step 6c — Switch hosting on

**Goal.** After the notice window closes with no sustained objection, let tenants
that opt in run on Inflect's own workspace.

```text
You are implementing Step 6c of the roadmap in
docs/claude-managed-agents-design.md. Read the global rules and definition of
done in the Roadmap of docs/claude-agent-sdk-design.md, all of "MA-C1", and the
6a pull request.

Before starting, confirm all of the following. If any is not true, stop and
report:
- the 6a notice was posted and emailed, and at least 30 days have passed since;
- no objection is sustained;
- 6b is deployed to production.

Goal: HOSTED_MANAGED_AGENTS_ACTIVE is true, and Inflect's organisation matches
what the notice said.

1. Set the constant true in its own commit. The commit names the 6a pull
   request and the date the window closed.
2. Set up Inflect's organisation as the notice described:
   - list its Console members and their roles (the people who can see
     transcripts) in the pull request;
   - confirm the workspace's residency;
   - set a spend limit on each workspace as a backstop to the entitlement.
3. Update docs/sub-processors.md to record that activation completed (step 4
   of the policy), and update this document's Current state.
4. Run one proving tenant in production. Fill the Phase 6 evidence row with:
   - the run id and the session id;
   - that the workspace held no session afterwards.
   Also record a second tenant, not opted in, being refused, by run id.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The constant change is its own commit, and the pull request links 6a with both window dates.
- [ ] The Console members and roles in the pull request match the notice.
- [ ] The evidence row is filled from production, not from a test.
- [ ] A tenant that has not opted in was refused in production, recorded by run id.

**Exit.** Tenants that opt in can use hosted agents without an Anthropic account of their own, under the terms they were notified of.

#### Step 6H — Phase 6 hardening

**Goal.** Prove that tenants sharing one of Inflect's workspaces cannot reach each
other's runs, and that hosting holds to the terms customers were notified of.

```text
You are implementing Step 6H of the roadmap in
docs/claude-managed-agents-design.md: the hardening step for Phase 6. Steps
6a, 6b and 6c are merged, and hosting has run in production. Read the global rules,
definition of done and "Operational evidence" in the Roadmap of
docs/claude-agent-sdk-design.md, and all of Phases 5 and 6 here.

Goal: evidence that a shared workspace keeps tenants apart, and that what is
stored at Anthropic matches the notice.

1. Adversarial read of 6b and 6c together, for what sharing a workspace adds:
   - Can one tenant's job read, answer or delete another tenant's session in the
     same workspace?
   - Are sessions selected only by recorded id, never by listing?
   - Does any agent name, agent body or session metadata identify a tenant?
     Archived agents cannot be deleted, so this one cannot be fixed later.
   - Can a tenant's burst exhaust the organisation's rate limit for the others?
   - Can a tenant run hosted without the entitlement, or after opting out?
   - Who in Inflect's organisation can see transcripts in the Console, and is
     that what the notice said?
   Fix what you find, each with a test.
2. A two-tenant production check. Two opted-in proving tenants run at the same
   time in the same workspace. Record:
   - each run's session id, from their own ledgers;
   - that neither job touched the other's session, from the provider's request
     log or Inflect's ledger, ids only;
   - that the workspace held no session afterwards.
3. Compare what is stored at Anthropic after a week of runs (archived agents,
   any surviving sessions) with the 6a notice. Record any difference, and treat
   a difference as a defect.
4. Update this document's Current state, the Phase 6 evidence row, and CLAUDE.md.

Deliver per the Definition of done.
```

**Hardening**

- [ ] Each adversarial question is answered in the implementation note, with a test for each defect found.
- [ ] The two-tenant production check shows no cross-tenant session access, recorded by ids.
- [ ] No agent object or session metadata in Inflect's workspace identifies a tenant, checked against the workspace itself.
- [ ] What remains at Anthropic matches the 6a notice, or the difference is fixed in this pull request.
- [ ] Console transcript visibility in Inflect's organisation matches what the notice said, with the role names recorded.

**Exit.** Hosted agents run for several tenants in one organisation without crossing between them, and store only what customers were told.
