inflect · claude managed agents · design v1 · 2026-10-24

# Claude Managed Agents in Inflect: hosted agents, and what hosting costs the tenant's data

> **Status: living design** — research into Claude Managed Agents and a
> recommendation for how, and how far, they enter Inflect's agent stack. Phase
> 5 is built through Step 5d, and Phase 6's hosted path through Step 6b, behind
> a constant that is false. The **Current state** section is true today. The **Roadmap**
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
- **Shape MA-B is offered but has not been exercised.** The connect wizard's
  Managed Agent tab (Step 3a) shows the Console configuration that points a
  Console-built agent at `/api/mcp` with a bound key. No Console-built Managed
  Agent has connected yet: Step 3H recorded its absence (owner decision,
  2026-11-22), while an Agent SDK program on the same wizard path did connect and
  was held to its grants (`docs/claude-agent-sdk-design.md`, "Operational
  evidence", Phase 3).
- **The tenant purge, connection removal and DSAR erasure reach the customer's
  workspace (Step 5c, #4166).** What Inflect created there is removed by the
  ids Inflect recorded (`usecases/managed-agents-cleanup.ts`, the calls in
  `src/lib/agentic/managed-agents/cleanup.ts`). The tenant purge, before any row
  goes, makes ONE bounded attempt with the connection's key: it deletes every
  session the run ledger records (kept ones included) and any a crash left
  unrecorded, found by listing sessions only by a recorded agent and taking only
  those whose metadata names the tenant and one of its runs, and archives every
  agent in `AgentProfileProvision`. Inflect keeps no key past the purge
  (decision 7), so what that attempt cannot finish ends, ids only, on a retained
  `ManagedAgentsCleanup` row in the terminal `PURGED_KEY_DESTROYED_UNFINISHED`,
  with an alert, for a person. Removing the connection makes the same clean-up,
  and a DSAR erasure deletes every KEPT session in every tenant where the person
  held a membership; both read the connection's key, which stays (a removed
  connection is disabled, not deleted), and are retried by `data-lifecycle`
  until done, or end `ABANDONED` after 30 days. A periodic
  reconciliation, run by `data-lifecycle`, retries every session whose latest
  ledger step is `SESSION_DELETE_FAILED` (a run's delete that Anthropic refused
  or could not take), by its recorded id and never a KEPT one, writing
  `SESSION_DELETED` on the run's ledger once it goes (#5843); it settles a
  session a dead worker abandoned, recorded only `SESSION_CREATED` and older
  than any run segment can last, by deleting it, or recording it kept when the
  connection keeps sessions (Step 5H, #4169), and never one whose run is still
  RUNNING, which a retry or a takeover reconnects to (decision 9); and it
  deletes a session recorded DELETED that still exists. Nothing has been created in a
  customer's workspace in production yet: the engine runs from Step 5d, and
  `AGENT_MANAGED_AGENTS` is off there (#5797).
  - **Known limit (#5802).** A DSAR erasure finds the person's tenants from
    their own audit rows, so a tenant where they held a membership and never
    acted (added by SCIM, SSO or org provisioning) is not reached, and a KEPT
    session there stays. The fix belongs with the erasure's operator entry
    point, which does not exist yet.
- **A customer can connect its own Anthropic workspace (Step 5a, #4164),
  behind the opt-in `AGENT_MANAGED_AGENTS` switch.** The `anthropic-workspace`
  provider (`src/app-layer/integrations/providers/anthropic-workspace/`) stores
  the workspace ID and keep-sessions choice in the connection's config and the
  API key encrypted as every connection secret. The host is fixed: `apiHost` is a
  `vendorOrigin` rule naming `api.anthropic.com` alone, no surface offers it for
  typing, and a configuration naming another host is refused at save and before
  any Test request. Test sends one `GET /v1/agents?limit=1` with the
  `anthropic-workspace-id` header, so an organisation-level key works too, and
  passes only when the response names the configured workspace. It creates
  nothing in the workspace and never calls `markAuthFailure`. The Admin →
  Integrations card says what Inflect will create there and offers "Keep sessions
  in my workspace", off by default (decision 4). With the switch unset the
  provider is not registered and the card does not render.
- **The Managed Agents engine is built (Step 5b, #4165) and turned on
  (Step 5d, #4167).** The driver (`src/lib/agentic/managed-agents/`) provisions
  an approved profile version as one agent per profile (Inflect's preamble as
  `system`, custom tools only) in one environment per connection (`cloud`,
  `limited`, no allowed hosts), recorded in `AgentProfileProvision`; checks the
  agent for drift before each session; runs the session with the tenant's
  instructions only in its `agent_with_overrides` override, a dollar budget
  derived from the run's caps and metadata naming the tenant and run by id;
  bridges every custom tool call through `runGuardedTool`; writes one
  `MODEL_CALL` and one span-derived Art 12 row per `span.model_request_end`;
  resumes a dropped stream without answering a call twice; and deletes the
  session in `finally`, or records it kept when the connection keeps sessions.
  It passes the driver conformance suite on a faux SSE transport with two
  declared variances (decision 3).
  - **What selects it.** `DRIVER_IMPLEMENTED['managed-agents']` is true (its own
    commit, so reverting it is the rollback) and `MANAGED_AGENTS` is a WRITTEN
    driver mode. A workspace can choose it on Admin → AI features only while
    `AGENT_MANAGED_AGENTS` is on and exactly one Anthropic workspace is
    connected and enabled; the setting refuses it otherwise
    (`MANAGED_AGENTS_NO_WORKSPACE`, `MANAGED_AGENTS_AMBIGUOUS_WORKSPACE`). The
    page explains the engine in plain words: the conversation exists in the
    customer's workspace until the run ends, unless the connection keeps it
    (decision 4), and Inflect cannot see each call's prompt (decision 3).
    `AGENT_MANAGED_AGENTS` stays off in production until #5797 is settled.
  - **What runs on it.** A profile of a workspace that chose it asks for it.
    Approval provisions the version's agent, so a Test run tries the approved
    version in force (`TEST_RUN_NEEDS_APPROVED_VERSION` for one under review).
  - **A removed, then re-enabled connection.** Its provision rows name agents
    the removal archived. A run of such a version is refused
    `managed_agents_agent_archived` before a session exists, and the next
    approved version is provisioned as a NEW agent.
  - **An agent edited or archived in the Console (#5854).** A run of the
    version in force is refused `managed_agents_agent_drifted`, and the
    sentence names the remedy that works: approve a new version. Before it
    updates the profile's agent, provisioning reads it at its latest version,
    and one ahead of the record or archived is replaced by a NEW agent rather
    than updated. The old agent stays on the earlier versions' rows, so a
    connection removal and a purge still archive it.
  - **The environment is checked like the agent (#5854).** Before each session
    the run reads the environment again and compares it with the hash of the
    configuration Inflect wrote (`AgentProfileProvision.environmentHash`);
    a changed or archived environment refuses the run
    `managed_agents_environment_drifted` before a session exists. A row from
    before the column is not refused for it: its first run records the hash of
    what Inflect wrote, never what it read, and compares.
  - **A dead segment's session is found at the next segment's start (#5854).**
    A worker that dies after `sessions.create` answers and before the ledger
    records the session leaves one nobody recorded. Every segment first lists
    the pinned agent's sessions through the crash window's own call, takes
    those whose metadata names this tenant and this run and that the run's
    ledger does not hold, records them and settles them.
  - **A retried or taken-over segment reconnects to its session (decision 9,
    #5854).** It does not pause for a person, and it never makes a second
    session for the segment. The worker anchors the segment and hands the
    engine where it began (`RequestContext.runSegmentFromSeq`); the engine
    reads its own part of the ledger (`readSegmentLedger`) and, when the newest
    session there was never settled, re-runs the agent and environment drift
    checks, reads the session (gone or ended by Anthropic: the run FAILS by
    name, `managed_agents_reconnect_session_gone` / `_terminated`), reads its
    history paged and bounded (5,000 events; past that the run fails
    `managed_agents_session_history_truncated`), and answers every custom-tool
    call with no result the Tool Runner's way: a result kept on the run's
    checkpoint as kept, the call the checkpoint names in flight
    `TOOL_CALL_OUTCOME_UNKNOWN`, any other `TOOL_CALL_NOT_RUN`. No call is run
    again. The checkpoint is the Tool Runner's `WorkflowRunCheckpoint` row,
    pointing at the session and span instead of holding a transcript. A
    session an earlier attempt already deleted or kept, or stopped (an
    interrupt in its history), is not continued, by name. The first
    `MODEL_CALL` of a reconnected segment records the session and the event it
    picked up after. A worker whose lease another worker took leaves the
    session alone: no answer, no interrupt, no delete.
  - **The client checks bodies against an allowlist (#5854).** Each POST may
    carry only the members the engine writes, an agent's `system` must be
    Inflect's preamble byte for byte, and a session's events may only be
    `user.message`, `user.custom_tool_result` and `user.interrupt`.
  - **Events from someone else holding the workspace's key are not detected**
    (decision 8). Every real tool call still goes through Inflect's checks.
  - **The run timeline** says, beside each span-derived decision row, that the
    call's prompt was not visible to Inflect.
- **Hosting in Inflect's own organisation (MA-C1) is proposed, not in effect
  (Step 6a drafts).** `docs/sub-processors.md` carries it as Anthropic (g),
  marked PROPOSED, NOT IN EFFECT, and the customer notice
  (`docs/notices/2026-11-23-anthropic-hosted-managed-agents.md`) was issued on
  2026-11-24; its objection window closes 2026-12-24. Decision 6 is recorded on
  #5865 and the change approved (see "MA-C1", "Notice").
- **The hosted path is built and cannot run (Step 6b, #4172).** Everything
  hosting needs exists behind the source constant `HOSTED_MANAGED_AGENTS_ACTIVE`,
  which is `false` (`src/lib/agentic/managed-agents/hosted-activation.ts`, a
  leaf module). Setting it true is Step 6c's one-line diff, after 2026-12-24.
  - **The constant is asked first.** Inflect's workspace id and key are
    deployment configuration (`AGENT_MANAGED_AGENTS_HOSTED_WORKSPACE_ID`,
    `AGENT_MANAGED_AGENTS_HOSTED_API_KEY`), and their one reader,
    `inflectHostedWorkspace`, returns before it reads either while the
    constant is false. So no run, provisioning or clean-up resolves Inflect's
    workspace or builds a client with its key, and no workspace can opt in. A
    guard reads the source for that order.
  - **One resolution.** `resolveManagedAgentsWorkspace` (`workspace.ts`) is what
    the driver and provisioning ask, and the engine setting asks its key-free
    twin: the tenant's own connected workspace wins (one that is ambiguous or
    unreadable refuses, never falls back); otherwise Inflect's workspace when
    the constant, the deployment's pair, an owner's opt-in, a residency that is
    not `LOCAL_ONLY` and the plan's entitlement all hold; otherwise the run is
    refused naming the first that failed (`managed_agents_no_workspace`,
    `_hosted_not_opted_in`, `_hosted_local_only`, `_hosted_not_entitled`).
    Every hosted record carries the connection id `inflect-hosted`, and a
    hosted session is always deleted at settle. The ledger's `SESSION_CREATED`
    step and every `MODEL_CALL` step record the workspace kind.
  - **The opt-in** is `TenantSecuritySettings.hostedManagedAgentsOptIn`, written
    only by `usecases/hosted-managed-agents-opt-in.ts` behind a literal
    `requirePermission('admin.tenant_lifecycle')`, by a person (an API key, an
    agent and a job are refused), audited. Opting in is refused unless hosting
    is offered, entitled and not `LOCAL_ONLY`; opting out is always allowed and
    runs Step 5c's clean-up for the tenant. The Admin → AI features section
    says what hosting stores, where and for how long, and renders nothing
    until hosting is offered.
  - **The shared workspace.** Every lookup is by recorded id; agent names and
    session metadata carry opaque ids only (asserted on the faux transport).
    The clean-up and the reconciliation reach a hosted tenant's records only.
    A purge of Inflect's workspace that cannot finish stays `OPEN` and is
    retried: decision 7 keeps no customer key past a purge, and Inflect's key
    is not destroyed with the tenant's rows. A DSAR erasure skips it, since no
    hosted session is ever kept.
  - **Capacity and cost.** One hosted run per tenant and two per deployment
    execute at once (`hosted-capacity.ts`, source constants), counted under
    one advisory lock by the SQL function `hosted_managed_agents_claim_slot`
    over runs holding a live run lease; a run over a cap is refused by name
    before any client exists. A hosted run is marked
    `WorkflowRun.hostedManagedAgents`, so its tokens (`costTokens`, and each
    span-derived `MODEL_CALL`) are recorded per tenant. Hosted runs need the
    plan entitlement `hostedManagedAgents`, which no plan includes until the
    owner opens one.

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
  deletes them. Nothing a tenant wrote outlives the run at Anthropic, unless the
  customer chose to keep sessions on that connection (decision 4). A kept
  session stays in the customer's own workspace, held by their processor at
  their direction, until they delete it or Inflect's purge, connection removal
  or a DSAR erasure does. That makes
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
| `MODEL_CALL` + Art 12 | one per `span.model_request_end`, with its `model_usage`. The prompt of each call is not visible, so the decision row's input digest covers what Inflect sent, not what the model saw. This is weaker than the other engines; the owner accepted it on 2026-10-30 (decision 3) |
| Guard on model text | on `agent.message` text, *after* Anthropic has stored it |
| Skills | an Inflect `activate_skill` custom tool (pinned, hash-checked, no upload), or uploaded skills pinned by `version`. The custom tool keeps the mount gate in Inflect |
| Residency | `LOCAL_ONLY` is refused, with a named reason |
| Record and minimisation | the run's ledger is written in Inflect as it happens. At settle the job deletes the session (`DELETE /v1/sessions/{id}`), so the transcript does not outlive the run at Anthropic, unless the connection keeps sessions (decision 4) |
| Tenant purge, DSAR | the purge must reach the provider: delete every session Inflect created, kept or not, and archive the agents. A DSAR erasure deletes every kept session Inflect recorded for the tenant's connections. An archived agent keeps its `system`, which is why that holds Inflect's fixed preamble and never a tenant's instructions |
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
  deletes them (always at settle: the keep choice of decision 4 is MA-C2's
  only);
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

**Anthropic's terms, re-read from the live pages on 2026-11-23 (Step 6a).** Each
term MA-C1 relies on is unchanged; none is worse and none is better for this
shape.

- **Zero Data Retention.** "Claude Managed Agents is stateful by design …
  Because of this, Managed Agents is not currently eligible for Zero Data
  Retention or HIPAA Business Associate Agreement (BAA) coverage. The exception
  for Zero Data Retention is self-hosted Claude Managed Agents, where you store
  that data yourself"
  ([overview](https://platform.claude.com/docs/en/managed-agents/overview)).
  The same exception is on the
  [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
  page, under "What ZDR does not cover".
- **Workspace geography.** "Workspace geo is set when you create a workspace and
  can't be changed afterward. Currently, `"us"` is the only available workspace
  geo." Workspace geo: "Controls where data is stored at rest"
  ([data residency](https://platform.claude.com/docs/en/manage-claude/data-residency)).
- **How long sessions are kept.** "Claude Managed Agents is a stateful
  resource; session transcripts persist until you delete them"
  ([API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)).
  "Deleting a session is permanent. It deletes the session's record, events,
  and associated sandbox"
  ([session operations](https://platform.claude.com/docs/en/managed-agents/session-operations)).
- **Deleting or archiving agents.** "Archiving makes the agent read-only and
  cannot be undone"; the agent lifecycle lists Update, List versions and
  Archive ([agent setup](https://platform.claude.com/docs/en/managed-agents/agent-setup)).
  The Agents API reference lists Create, List, Get, Update and Archive, and no
  delete ([API reference](https://platform.claude.com/docs/en/api/beta/agents)).
- **Who sees transcripts.** "The session viewer is only accessible to
  Developers and Admins"
  ([observability](https://platform.claude.com/docs/en/managed-agents/observability)).

Two things on those pages that this section did not record before:

- **Self-hosted Claude Managed Agents** is a service an organisation runs on its
  own infrastructure, with its own database, and it is the one form of Managed
  Agents eligible for ZDR. It is a different shape from MA-C1, where Anthropic
  runs the service in Inflect's organisation, so it changes none of MA-C1's
  terms. Whether Inflect ever hosts the service itself is a separate decision,
  and nothing here takes it.
- **Retention regardless of arrangement.** "Even with ZDR or HIPAA arrangements
  in place, Anthropic may retain data where required by law or where it has
  been flagged by Anthropic's automated trust and safety systems. As a result,
  if a chat or session is flagged, Anthropic may retain inputs and outputs for
  up to 2 years" (API and data retention). This is general to Anthropic's API,
  the Messages API calls already on the sub-processor row included, so it is
  not a Managed Agents term; the register entry and the notice state it.

**Notice.** The register entry is Anthropic (g) in `docs/sub-processors.md`,
marked PROPOSED, NOT IN EFFECT. The customer notice,
`docs/notices/2026-11-23-anthropic-hosted-managed-agents.md`, was **issued on
2026-11-24**.

- Date the notice was sent: 2026-11-24 (repo owner).
- Date the 30-day window closes: 2026-12-24. Step 6c may not activate hosting
  before then.
- Decision 6 — recorded by the repo owner on #5865 on 2026-11-23, once for
  every use of Anthropic as Inflect's sub-processor: the EU SCCs incorporated in
  Anthropic's DPA; no transfer impact assessment, the repo owner accepting
  proceeding without one.
- Approval of the change and the notice (policy step 2): the repo owner,
  2026-11-23. Objection address: privacy@inflect.bg.

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
   **Decided (owner, 2026-10-30): accepted.** The Art 12 row records what
   Inflect sent and every tool call through the funnel, and says that each
   call's prompt is held in the customer's workspace. No tracing ingest is
   built.
4. **For MA-C2, what happens to a session at settle.** Deleting it minimises
   what persists at Anthropic, and costs Anthropic's Console view of past runs,
   which Inflect's own run timeline replaces. **Decided (owner, 2026-10-30): the
   customer's choice, per connection, deleting at settle by default.** A
   customer may keep their sessions in their own workspace. A kept session is
   still deleted by Inflect when the tenant is purged, when the connection is
   removed, and on a DSAR erasure in the tenant. Inflect cannot read a
   transcript to find one person in it, so a DSAR erasure deletes every kept
   session Inflect recorded for the tenant's connections. The choice is MA-C2's
   only: a session in Inflect's own organisation (MA-C1) is always deleted at
   settle.
5. **Sub-processor framing for MA-C2.** Anthropic acts as the customer's own
   processor, used at the customer's direction, listed as an opt-in per-tenant
   integration like GitHub and SharePoint. **Confirmed by the owner on
   2026-10-30, as proposed.** Step 5a writes the `docs/sub-processors.md` row
   in these words.
6. **Transfer basis for MA-C1.** For tenants that opt in, Anthropic stores
   session data as Inflect's own sub-processor, in the US, without ZDR. The
   owner decided on 2026-10-30 that these are recorded at step 6a and not
   before. Before the 6a notice goes out, someone must record three things on
   its pull request,
   per *Sub-processors: who confirms which half of step 2* in
   `docs/change-management-policy.md`:
   - the transfer mechanism for EU personal data (SCCs, or the basis Anthropic's
     DPA gives);
   - whether a transfer impact assessment is obtained;
   - if one is not, who accepted proceeding without it.

   The owner's decision to host is a product decision, and it does not answer
   these.

   **Where they are recorded (owner, 2026-11-23):** once, on #5865, for every
   use of Anthropic as Inflect's sub-processor. The Messages API engines and the
   assistant already carry personal data there, and their register entry says
   only "per its terms". The Step 6a pull request cites that record and holds
   only what is specific to hosting: the notice, its dates and the objection
   address. The notice still waits for all three to be recorded.
7. **What a purge does when it cannot reach the customer's workspace, and whom
   a DSAR erasure reaches.** Step 5c found that the remote clean-up's retry
   could authenticate after a tenant purge only by keeping the customer's
   Anthropic key past the purge, which is a retention question.
   **Decided (owner, 2026-11-22):**
   - **Inflect never keeps the customer's key past the purge.** The purge makes
     its remote clean-up ONCE, before any of the tenant's rows are deleted, with
     the connection's key as it stands then. What that attempt cannot finish is
     written, ids only (workspace, connection, session and agent ids, a named
     reason, timestamps, and no key or ciphertext of one), to a retained record
     that is never marked done: it ends in a named terminal outcome
     (`PURGED_KEY_DESTROYED_UNFINISHED`), raises an operator alert and emits a
     metric, so a person can finish the job in the customer's workspace. Step
     5c's item 2 ("retried by the existing data-lifecycle job until it
     succeeds") therefore does NOT hold for the purge path.
   - **A DSAR erasure reaches every tenant where the erased person held a
     membership**: after the erasure commits, every KEPT session in each of
     those tenants is deleted.
8. **Events sent into a running session by someone else holding the
   customer's workspace key.** The Step 5H adversarial read (#5854, finding 3)
   found that such a key holder could post a `user.message`, a
   `user.custom_tool_result` or a `user.tool_confirmation` into a session a run
   is driving, or attach resources to it, and the engine would not tell those
   events from its own. **Decided (owner, 2026-11-23): accepted as a risk.**
   Decision 5 makes the workspace the customer's own, and anyone holding its
   key can already act in it directly. Inflect's funnel still checks every
   real tool call the agent makes. No detection is built. The engine-settings
   page says so in one sentence.
9. **What a retried segment does with the session its dead attempt created.**
   Before this, a run never re-attached to a session: a retried segment that
   had already made a call paused for a person (#5854 item 3, the fallback
   Flue keeps), and one that had not started a new session.
   **Decided (owner, 2026-11-25):** a retried, or lease-taken-over, Managed
   Agents segment that already made a tool call does NOT pause. It RECONNECTS
   to the session it created and continues there, reading the session's event
   history and answering each pending custom-tool call the way the Tool Runner
   continuation does: a kept result as kept, the call in flight
   `TOOL_CALL_OUTCOME_UNKNOWN`, a call not run `TOOL_CALL_NOT_RUN`. The
   reconciliation leaves such a session alone while its run is live. Flue keeps
   the pause, because its runtime cannot resume. See
   `docs/implementation-notes/2026-11-25-fix-5854-ma-reattach.md`.

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

Built for #4164; the Current state section above describes the result, and
`docs/implementation-notes/2026-11-22-step-5a-anthropic-workspace.md` the
decisions.

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
   workspace (agents, one environment, sessions), that it deletes sessions
   when each run ends unless the customer chooses on the card to keep them
   (decision 4, off by default), and that a kept session is still deleted on
   tenant purge, connection removal and a DSAR erasure.
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

Built for #4165; the Current state section above describes the result, and
`docs/implementation-notes/2026-11-22-step-5b-managed-agents-driver.md` the
decisions.

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
      ledger, unless the connection keeps sessions (decision 4); a kept
      session is recorded as kept, so 5c can find it.
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

Built for #4166; the Current state section above describes the result, and
`docs/implementation-notes/2026-11-22-step-5c-managed-agents-purge.md` the
decisions. Two things in the prompt below changed while it was built, and a
third after:

- **The purge is attempted once and never retried** (decision 7). Item 2's
  retry holds for connection removal and DSAR erasure, whose connection row,
  and so whose key, stays; it does not hold for the tenant purge.
- **The reconciliation also retries a failed delete** (#5843, after 5c
  merged). Item 4 named only the lost delete, so a session whose delete failed
  at the end of its run was retried only by a purge, a connection removal or
  (when kept) an erasure. The same reconciliation now retries every session
  whose latest step is `SESSION_DELETE_FAILED`, never a KEPT one, and records
  `SESSION_DELETED` when it goes; a 401/403, an unreachable provider or a
  running session leaves it for the next pass.
- **A retried clean-up does not live for ever.** A connection-removal or DSAR
  record still not done 30 days after it opened ends `ABANDONED`, with the same
  alert as an unfinished purge (`CLEANUP_ABANDON_AFTER_DAYS`). This is an
  implementation decision of Step 5c, not an owner decision: a 401/403 stays a
  retryable outcome, and without a limit a revoked key would keep a record open
  indefinitely.

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
   - delete every session Inflect recorded for that connection, kept ones and
     any a crash left behind;
   - archive every agent recorded in AgentProfileProvision (agents cannot be
     deleted).
   Use recorded ids only, never a list-and-match over the customer's workspace:
   Inflect deletes what it created and nothing else.
2. A provider that cannot be reached does not block the rest of the purge. The
   remote clean-up is recorded with a named outcome and retried by the existing
   data-lifecycle job until it succeeds. It is never reported done when it is not.
   (Superseded for the tenant purge by decision 7: one attempt, then a terminal
   record with an alert. Still true for connection removal and DSAR erasure.)
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
- [ ] An unreachable provider never marks the clean-up done (test). On connection removal and DSAR erasure the retry succeeds once it is reachable (test); on the tenant purge the attempt is made once and ends in `PURGED_KEY_DESTROYED_UNFINISHED` with no key kept (test, decision 7).
- [ ] The crash window: a session on a recorded agent with this tenant's metadata and no step is deleted; one naming another tenant, or a run the tenant does not hold, is not (test).
- [ ] Disconnecting a workspace triggers the same clean-up, and a DSAR erasure deletes kept sessions only, after the erasure commits (tests).
- [ ] Two tenants in one workspace: the clean-up of one never touches the other's sessions, agents or records (test).
- [ ] `docs/data-retention.md` and `tenant-purge-retained-never-cascades` agree with the new table's retention class.
- [ ] The reconciliation deletes a lost session and emits its metric (test).
- [ ] The reconciliation retries a session whose delete failed, records it deleted, leaves a KEPT one alone, and leaves one the provider cannot take for the next pass (tests, #5843).

**Exit.** Anything Inflect creates in a customer's workspace can be removed, and is removed when the tenant or the connection goes.

#### Step 5d — Turn the Managed Agents engine on

Built for #4167; the Current state section above describes the result, and
`docs/implementation-notes/2026-11-23-step-5d-managed-agents-on.md` the
decisions. Production ran `960503a11` (the Step 5c merge, which carries 5b's
READ_ONLY value) before `MANAGED_AGENTS` was written, confirmed on
`/api/health` on 2026-11-23. Three things the prompt below does not say were
decided while building it:

- **Re-enabling a removed connection** refuses a run of an archived agent by
  name and provisions a new agent on the next approval; it does not
  re-provision the version in force in place.
- **A Test run tries the approved version only** on this engine: approval is
  what provisions.
- **The E2E executes the queued run with the worker's own job body**
  (`tests/e2e/run-queued-agent-run.ts`): the harness has no worker.

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
(sessions deleted at settle unless the connection keeps them) are recorded as
decided. If either is not, stop and report.

Goal: DRIVER_IMPLEMENTED['managed-agents'] is true; the engine settings page
offers it only to a tenant with a connected workspace; the builder's Test run
works on it.

1. Flip the flag in its own commit.
2. setAgentDriverSetting and the PUT schema accept MANAGED_AGENTS. A tenant
   without a connected workspace is refused with a named reason. The settings
   page explains the engine in plain words, including that conversations exist
   in the customer's workspace until each run ends, unless the customer keeps
   them on the connection (decision 4).
3. The run timeline marks span-derived decision rows, so a reviewer can see that
   the per-call prompt was not visible to Inflect.

Tests: an E2E spec on isolatedTenant with a faux workspace that connects,
selects the engine and completes a Test run, then asserts the faux workspace
holds no session (the connection at its default). An integration test with the
connection keeping sessions asserts the session remains and is recorded as
kept.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The flag flip is its own commit, and the deployed image was confirmed before merge.
- [ ] A tenant without a connected workspace cannot select the engine (test).
- [ ] After the E2E run the faux workspace holds no session.
- [ ] On a connection that keeps sessions, the session remains and is recorded as kept (test).
- [ ] Span-derived decision rows are labelled in the run timeline (rendered test).

**Exit.** A tenant can run a profile in its own Anthropic workspace, and nothing tenant-authored stays there after the run unless the customer chose to keep it.

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
   - that the workspace holds no session afterwards (the connection at its
     default), checked through the provider's list endpoint, with ids only.
3. Edit the provisioned agent's system prompt in the Console, run again, and
   record the AGENT_DRIFTED refusal.
4. Purge rehearsal: turn on keeping sessions, run once, then disconnect the
   workspace, and record that the recorded agents are archived and no session
   remains, the kept one included (decision 4).
5. Update this document's Current state, the evidence row in the Agent SDK
   document, and CLAUDE.md's "Claude agent engines" section.

Deliver per the Definition of done.
```

**Hardening**

- [ ] Each adversarial question is answered in the implementation note, with a test for each defect found.
- [ ] A production run in a real workspace completed, and the workspace held no session afterwards (recorded by method and date).
- [ ] The kill-switch drill and the drift refusal were observed for real, by run id.
- [ ] The disconnect rehearsal archived the recorded agents and left no session, a kept one included.
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

Built for #4172; the Current state section above describes the result, and
`docs/implementation-notes/2026-11-24-step-6b-hosted-managed-agents.md` the
decisions. Three things the prompt below left open were decided while
building it:

- **A run over a capacity cap is refused, not held.** It settles before any
  client exists, with a named reason; holding it would keep a worker and its
  run lease busy, and re-enqueueing a segment is dropped by BullMQ's
  per-segment job id (#5900).
- **The purge of Inflect's own workspace is retried.** Decision 7's one
  attempt follows from destroying the customer's key with the tenant's rows;
  Inflect's key is not destroyed, so an unfinished purge record stays `OPEN`
  and data-lifecycle retries it, or it ends `ABANDONED` after 30 days.
- **No plan is entitled to hosting.** Which plans include it is the owner's
  decision; until it is made, every hosted run is refused
  `managed_agents_hosted_not_entitled`.

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
