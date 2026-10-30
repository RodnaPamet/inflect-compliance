inflect · claude agent sdk · design v1 · 2026-10-24

# The Claude Agent SDK in Inflect: customer-built agents without a CLI

> **Status: living design** — research into Anthropic's Claude Agent SDK and a
> recommendation for how it enters Inflect's agent stack so that a customer can
> set up an agent of their own inside the product, with no command line. None
> of it is built. The **Current state** section is true today and is the ground
> the proposal stands on. The **Roadmap** section is the plan: one pull request
> per step, each gated on the owner decision it names. Facts about the SDK were
> read from Anthropic's live documentation on 2026-10-24 and are cited inline.
> The SDK changes faster than this repository does, so re-read the cited page
> before building any step. If the code contradicts a fact here, the code wins
> and the pull request that finds it corrects this document.

## The answer, briefly

The Claude Agent SDK is Claude Code's agent loop packaged as a library. It is a
*harness*, not a hosting service: whoever calls it runs it. That makes the
"without a CLI" requirement a product question rather than an SDK one, and
there are three ways to answer it.

| Route | Who runs the agent | What the customer does | Verdict |
| --- | --- | --- | --- |
| **A. Inflect-hosted** | Inflect's worker runs the SDK as a run driver beside `static` and `flue` | Fills in an **agent builder** in `/agents`: instructions, tools from the agent's existing grants, skills, model tier, trigger. Never sees the SDK. | **The builder is recommended. This SDK as its engine is not yet.** Step 4a measures it against the Tool Runner engine, if a profile ever needs it |
| **B. Customer-hosted** | The customer runs their own Agent SDK code | Clicks **Connect an agent you run** on a registered agent; Inflect mints a bound key and generates the SDK configuration to paste in. The harness scanner learns to recognise Agent SDK code. | **Recommended.** This is where the SDK fits Inflect best: cheap, and mostly a UI over controls that exist |
| **C. Anthropic-hosted** | Claude Managed Agents, in Inflect's or the customer's Anthropic organisation | Inflect provisions the agent through Anthropic's API from the same builder | **Planned, after the Tool Runner engine.** Phase 5 runs it in the customer's own workspace. Phase 6 runs it in Inflect's, for tenants that opt in, once a 30-day sub-processor notice has run (owner decision, 2026-10-24). See `docs/claude-managed-agents-design.md` |

Route A is the one that delivers "set up my own agent without a CLI", because
the tenant never touches code at all. It works only if every control the
register already enforces stays **in front of** the engine, the way they stay
in front of Flue today. The design rule is the one
`src/lib/agentic/flue/tools-adapter.ts` already states for Flue: *the external
engine decides what to try; the funnel decides what is permitted.*

The research changed the engine question. The Agent SDK is Claude Code as a
library. It runs one CLI subprocess per run, and every default is permissive:
built-in shell, file and web tools are on, and host settings load. Inflect
refuses all of that already, so most of this document is a lockdown that turns
defaults off. The Messages API Tool Runner (`docs/claude-tool-runner-design.md`)
runs in-process with only the tools it is handed, and has nothing to turn off.
For the builder's agents it is the lighter engine. This SDK's distinctive
strength is agents that need a machine of their own, and those are the
customer's to host: that is Route B.

## Current state (true today)

### What a tenant can configure today, and the gap

A tenant can already do everything *around* an agent in the product, with no
code:

- **Register it** (`RegisteredAgent`, `/agents`). Owner, EU AI Act system
  link, autonomy level 0–6, the three exposure axes, risk tier, status.
- **Grant it tools** (`RegisteredAgentTool`). The allowlist is
  deny-by-default and keyed on the register.
- **Bound it** with a policy card (`AgentPolicyCard`, versioned), a kill
  switch, a circuit breaker, a monthly budget and a concurrency cap.
- **Teach it** with tenant-authored skills (`TenantSkill` /
  `TenantSkillVersion`, #3680). A skill mounts only once somebody other than
  its author approves it and it has a passing evaluation record.
- **Trigger it** from the Ask page (the tenant's designated interactive agent,
  ADR 0004), from an automation rule (`INVOKE_AGENT`, #3471), or from a
  schedule.
- **Connect an agent it runs elsewhere**, from the agent's page, since Step 3a
  (#4155). **Connect an agent you run** mints an API key bound to the agent
  (`TenantApiKey.agentId`, `maxAutonomyLevel` at or below the agent's level)
  through the api-keys route, and shows the Agent SDK options (TypeScript and
  Python) or the Console configuration for a Managed Agent that point the agent
  at `/api/mcp`. The key carries exactly the scopes the agent's grants need
  (`connectKeyScopes` in `src/lib/agentic/connect-wizard.ts`).

Since Step 2c a tenant can also have Inflect run what it says the agent should
*do*: it writes a profile behind the `AGENT_PROFILES` flag (see "Agent profiles"
below), an owner chooses the Tool Runner engine, and the Behaviour tab's Test
run runs a version read-only, as the agent. Outside a profile, an Inflect-hosted
run executes a `WorkflowDefinition` from `src/lib/agentic/workflow-registry.ts`
(nine in `src/lib/agentic/workflows/` plus the registry's own `diagnostic`), and
each one is written by this repository. So "set up my own agent" today means one of two things. Either the
tenant picks one of our workflows, or it writes and hosts the agent itself and
uses Inflect to govern it. The second option needs code, a runtime and usually a
CLI. That is the gap this design closes.

### The driver seam

`src/lib/agentic/drivers/` is where an engine plugs in. A `RunDriver` is one
function, `(ctx, runId, def, fromSeq, runStartMs) => Promise<RunDriverOutcome>`.
`DRIVERS` maps `static` and `flue` to implementations.

Which engine runs is the AND of four terms, each able only to narrow
(`src/lib/agentic/agent-driver.ts`, `docs/implementation-notes/2026-09-20-agent-driver-seam.md`):

1. the operator's process-wide switch (`AGENT_DRIVER_FLUE`, opt-in: only `1`
   or `true` count);
2. the tenant's setting (`TenantSecuritySettings.agentDriver`, enum
   `AgentDriverMode { STATIC FLUE }`);
3. whether this build implements the engine (`DRIVER_IMPLEMENTED`);
4. whether the workflow definition asks for it (`WorkflowDefinition.driver`).

Anything else resolves to `static`, with a named reason in the
`WORKFLOW_RUN_STARTED` audit row. The run records the engine it executed on in
`WorkflowRun.driver`, through `recordedModeOf` (#4285), a total map from `AgentDriver`
to the stored mode, so a new engine cannot compile until it names its stored
value (0H).

**Where the tenant sets it.** Admin → AI features, in the "Agent engines"
section (Step 0c, #4181).

- Every admin can read the gate: `GET /admin/agent-driver` takes `admin.view`.
- Only an owner can change it: `PUT` takes `admin.tenant_lifecycle`. The change
  goes through a confirmation that says what happens to running and future runs.
- An owner also sees the six-term Flue wiring checklist (`GET /admin/flue-wiring`).
  It is not requested for anyone else, so their visits write no `AUTHZ_DENIED`
  rows.

Each `StaticDriverReason` has its own sentence. When the deployment's switch is
off, choosing Flue is disabled, but returning to the built-in engine is not: a
stored Flue choice takes effect the moment the operator turns the switch on, so
the narrow is always offered (0H). The headline reports Flue as running only
when nothing known stops a run. For an owner whose checklist shows no active
agent or bound key, it says no Flue run can start yet. That section is the only
control for the column.
Admin → Integrations used to carry a second control, and now links to the
section instead.

A later engine gets its choice on that section by adding its mode to
`AGENT_DRIVER_MODES`, and its name and description to
`admin.agentEngines.engine` in both catalogues.

### How Flue was made safe, which is the template

Flue (`@flue/runtime`, an in-process ESM library) is the precedent for running
an engine we did not write. Every control below is something an Agent SDK
driver would have to reproduce:

| Control | Where it lives for Flue |
| --- | --- |
| Tools reach the funnel and nothing else | `flueToolsFor` → `offerToolSet` → `runGuardedTool` → `runReadTool` / `runProposeTool`. The core is in `engine-tools/` and is shared by every engine; `flue/tools-adapter.ts` supplies only Flue's tool shape |
| AI Guard on the model's arguments (egress) and on tool results (untrusted input) | `runGuardedTool`, steps 1 and 3 |
| The advertised tool set is the grant ∩ card ∩ scope ∩ autonomy ceiling | `offerToolSet` (`engine-tools/offer-tools.ts`) |
| Sandboxes, bash, file write/edit and channels are refused | `flue/refused-capabilities.ts` + `tests/guards/flue-refused-capabilities.test.ts` |
| Runtime-supplied tools are reported, not hidden | `flue/runtime-tools.ts` (`task`, `activate_skill`) |
| Kill switch asked per turn, not only at start | before boot in `flue/execute.ts`, then before every model call: the interceptor in `flue/telemetry.ts` awaits the run binding's `beforeModelCall` (#4196) |
| Run caps (wall clock, tool calls, tokens) charged per tool call, and checked again before every model call | `createRunBudget` in `execute.ts`; `beforeModelCall` refuses the next model call once a cap has latched (#4196) |
| Every tool call is a hash-chained `WorkflowStep`, and every model call is counted by a `MODEL_CALL` step naming how many calls it covers (owner decision 2026-10-25, #4197) | `TOOL_CALL` and `MODEL_CALL` through `recordStep`; one `MODEL_CALL` per dispatch, with `modelCalls` |
| EU AI Act Art 12 decision row per model call | `flue/model-decision.ts` → `logAiDecision` |
| Residency: a `LOCAL_ONLY` tenant never reaches an external model | `flue/model-selection.ts`, which picks a model specifier per run, and never `setProvider` per run (module singleton, cross-tenant race) |
| Delegation is capped and narrows | `flue/delegation-gate.ts` (fan-out), `flue/subagents/` (subset of the parent's tools, depth 1) |
| Skills mount only through the gate, and the run pins their hashes | `flue/skills/mount-gate.ts`, `WorkflowRun.mountedSkills` |
| A reasoning run must be vouched for by the register | `startWorkflowRun`: `isReasoningEngine(chosenDriver)` requires `standing === 'vouched'` |
| Per-run state is in memory, and `WorkflowRun` is the system of record | `flue/run-binding.ts`, ratified in `docs/implementation-notes/2026-09-23-flue-session-state-deviation.md` |

Flue's known limits are worth recording, because two of them are where the
Agent SDK differs. Its model hook carries neither prompt nor output text, so the
guard can sit only at the tool boundary. Its provider registry is a
process-wide singleton, so residency has to be chosen by model specifier.

### Anthropic is already the model sub-processor for agent runs

`docs/sub-processors.md` names Anthropic (Claude API) for Flue agent runs of
`aiResidency=EXTERNAL` tenants. The data shared is the run's prompt: the
workflow description, the declared input and the read-tool output. Anthropic is
reached with the deployment's `ANTHROPIC_API_KEY` and `AGENT_FLUE_MODEL`
(default `claude-sonnet-5-5`). The owner decided on 2026-10-18 that naming a new
data category on the existing row is sufficient for the agent runtime.

### The engine-neutral tool core

Since Step 0a (#4176), what an engine is offered and how its calls are guarded
live in `src/lib/agentic/engine-tools/`, which imports no engine. ESLint refuses
`@flue/*`, `valibot` and `@earendil-works/*` there.

- `offerToolSet(inv, build, { sourcePrefix, … })` runs the scope, autonomy and
  read-only narrowing once per run, in a single loop. It hands the engine's
  `ToolBuilder` only the tools that passed, each with a `run` that is already
  bound to the guarded call. A builder that cannot convert a schema returns
  `null`, and the tool is reported as `UNCONVERTIBLE_SCHEMA`.
- `runGuardedTool` takes the guard source prefix from the engine, with no
  default. A second engine's guard audit rows therefore carry its own name.
  Flue passes `'flue'`, so its sources (`flue-tool-args:<name>:<id>`, and the
  rest) are unchanged.
- `isReasoningEngine(driver)` in `agent-driver.ts` is the single question
  `startWorkflowRun` asks for the registration gate, the skill pin and the
  worker hand-off. A driver missing from its record fails `tsc`.

### The driver conformance suite

Since Step 0b (#4220), one table of scenarios holds every run driver to the
same controls (`tests/helpers/driver-conformance.ts`). An engine supplies an
adapter: it scripts the model's turns, starts a run and reads back what
happened. The scenarios assert only on that observation, never on an internal
call.

- Ten run scenarios:
  - a kill switch engaged between model calls;
  - each of the three caps;
  - the ledger accounting for every model call and tool call;
  - one Art 12 row per model call, carrying its step's digest;
  - a secret-shaped argument refused before the funnel;
  - a flagged result withheld from the model;
  - a `LOCAL_ONLY` tenant never sent to an external model;
  - the tool surface bounded and every engine-supplied tool reported.
- One admission scenario, run against the database. An unvouched agent (no
  binding, not in the register, or suspended) is refused before the run row
  exists. A vouched agent is the positive control.
- A variance lets an engine assert a stronger property in place of a
  scenario, and only with a named owner decision. Flue declares none.
- Flue runs the run half in `tests/flue/driver-conformance.test.ts` and the
  admission half in `tests/integration/driver-conformance-admission.test.ts`.

The ledger scenario reflects an owner decision (2026-10-25, #4197). A
`MODEL_CALL` step may cover a whole dispatch, provided it names how many model
calls it covers. Flue writes one such step per dispatch.

### Agent profiles

Since Step 1a (#4143), a tenant can write what an agent should do as a
versioned, approved agent profile, behind the opt-in `AGENT_PROFILES` flag. With
the flag off, every profile route answers 404 before its permission check, and a
profile run key is refused at admission.

- **The model.** `AgentProfile` is one row per registered agent, pointing at the
  approved version in force. `AgentProfileVersion` is immutable and holds:
  - the instructions, encrypted at rest, and their SHA-256;
  - the tools, a subset of the agent's grants;
  - the skills;
  - a model tier, which is a deployment tier and never a model id;
  - an effort and a turn bound, at most `ENGINE_CAPS.MAX_STEPS`;
  - the output kind and the allowed triggers.
- **The lifecycle.** DRAFT, SUBMITTED, then APPROVED or REJECTED, with RETIRED
  terminal. An edit is a new version. Approval and rejection take a person
  other than the author, holding `admin.agent_registry` (owner decision 3).
  This is held in `usecases/agent-profiles.ts`, by the CHECK
  `AgentProfileVersion_not_self_decided`, and by a trigger that freezes a
  version's text and settings for every role.
- **At save and again at approval:**
  - the instructions are sanitised, capped at 16,000 characters and scanned by
    the skill text scan. They are refused by rule id, never stored;
  - every tool must be granted now, or it is refused by name;
  - every skill must be one a run could mount, or it is refused by name
    (`SKILL_UNKNOWN`): a shipped skill the text scan refused or the mount gate
    refuses is not one;
  - together the skills' catalogue lines must fit the per-run budget, priced
    with the `catalogBytes` a run of the version is refused by
    (`SKILL_CATALOGUE_OVER_BUDGET`, a 409, #4589).
- **Admission.** `startWorkflowRun` asks `resolveRunDefinition`, and only that
  one call changed:
  - a key that does not ask for a profile behaves exactly as before;
  - `agent-profile:<profileId>@v<n>` resolves only to the approved version in
    force, inside the caller's tenant, after recomputing the instructions'
    hash;
  - the compiled definition asks for a reasoning engine and carries the
    version as `def.profile`;
  - a run that is admitted pins `profileVersionId` and
    `profileInstructionsHash`, write-once.
- **Only the Tool Runner engine runs a profile** (Step 2c, #4150; decision 7
  below keeps Flue out). `runsProfiles` is true for `tool-runner` alone, and a
  profile's definition asks for that engine. Admission refuses a profile on any
  other engine before the run row exists: `PROFILE_NEEDS_REASONING_ENGINE` where
  the tenant's engine is static or Flue, `PROFILE_ENGINE_CANNOT_RUN_PROFILES` on
  a reasoning engine whose entry is false.
- **The tools a run is offered** are narrowed in the engine-neutral core.
  `offerToolSet`'s `profileTools` offers the intersection of the version's
  tools and the agent's current grants. It records each tool lost to a revoked
  grant as `PROFILE_TOOL_NOT_GRANTED`, and an engine that runs profiles passes
  it.

- **The Behaviour tab** (Step 1b, #4144) is on the agent detail page while the
  flag is on, under `admin.agent_registry`; a view-key reader finds it disabled.
  - It shows the version in force read-only, the open version, and every
    version's status, author, decider and instructions hash.
  - Instructions render as text, never markup.
  - An editor in a Sheet writes the next version as a DRAFT. Its tool and skill
    pickers list only what the server's read offers: the agent's current grants
    and the skills it may mount, each with its catalogue cost against the
    per-run budget (#4599).
  - A reviewer who is not the author sees the submitted text diffed against the
    version in force. Approve sends the hash on screen. Reject asks for a
    reason.
  - Test run is shown on a submitted or approved version (Step 2c). Where the
    workspace's engine runs profiles, it starts a read-only run of that version
    as the agent and opens the Runs tab; otherwise it is disabled and says why:
    the engine (named), the engine not in force, the agent not ready, or a
    version that does not allow `TEST_RUN`.
- **A rejection says why.** `AgentProfileVersion.rejectionReason` is sanitised,
  at most 1,000 characters, encrypted at rest, and never audited. The trigger
  writes it only in the move from SUBMITTED to REJECTED, requires it there, and
  never lets it be revised. The rotation sweeps' re-wrap is the one exception.
- **The surface can be opened to named tenants only** (Step 1H, decision 8).
  `AGENT_PROFILES_TENANTS` holds comma-separated tenant slugs. The route gate
  reads the URL's slug before any context exists, and the usecases and
  admission read `ctx.tenantSlug`. A tenant the list does not name sees exactly
  what the switch being off shows: no tab, a 404 on every route and
  `PROFILES_DISABLED` at admission. A context with no slug is never named.
  `AGENT_PROFILES` on still opens the surface to every tenant.
- **With `AGENT_PROFILES` unset, the workspace's organization decides** (#4557,
  owner decision 2026-10-30). An org admin turns profiles on or off for every
  workspace under the organization on the org's Settings page
  (`Organization.agentProfilesEnabled`, audited as `ORG_AGENT_SWITCHES_CHANGED`).
  `0`, or any other set value, closes the surface to every workspace the
  allowlist does not name; a workspace with no organization stays closed. One
  reader answers for every surface: `agentProfilesDecisionFor` in
  `src/lib/agentic/agent-switches-policy.ts`, over the rule in
  `agent-switches.ts`.
- **The read is the builder's.** For an agent with no profile,
  `getAgentProfile` answers `profile: null` instead of refusing. Each answer
  carries:
  - the editor's `options`;
  - each version's `canDecide`, so the page offers exactly what the server
    accepts;
  - member labels in place of user ids;
  - `testRun`.

- **`allowedTriggers` is checked where a trigger starts a run.** The Test run
  checks `TEST_RUN` (Step 2c); the Ask page and automation check theirs when they
  gain a start path in Phase 2.
- **The worker and resume execute what admission pinned** (Step 2c). They
  rebuild a profile run's definition from the run's own `profileVersionId`,
  while its instructions hash to `profileInstructionsHash`, never by approval
  status and never from the registry, which knows no profile key.

### What the harness scanner recognises

The reference scanner's `code` source
(`packages/agent-harness-scanner/src/sources/code/recognize.ts`) reads static
code for LangChain, LangGraph and Claude Agent SDK agents (Step 3b, #4156).

- **What counts as an SDK agent.** A call resolved through the file's imports:
  - `query` from `@anthropic-ai/claude-agent-sdk`;
  - `query` or `ClaudeSDKClient` from `claude_agent_sdk`;
  - in Python, a `ClaudeAgentOptions` that no such call in its file consumes.
  A local function called `query` is not one.
- **What is reported.** Its tools, model and credentials, as for the other
  frameworks.
- **Its options become NOT MET verdicts.** The owner's mapping of 2026-10-29
  (`AGENT_SDK_OPTION_CRITERIA` in `src/lib/agentic/harness-findings.ts`):

  | Option | Criterion |
  | --- | --- |
  | `bypassPermissions` | `H3.propose_not_commit` |
  | host settings loaded | `H3.skills_declared` and `H2.tools_allowlisted` |
  | an `allowedTools` wildcard | `H2.tools_allowlisted` |
  | a callable `Bash` or `WebFetch` | `H2.tools_allowlisted` |
  | no hook, with `settingSources: []` | `H3.payloads_guarded` |

  - Each verdict carries the option's `code://` locator as evidence.
  - Code never makes a criterion MET.
  - An option the reader could not resolve concludes nothing, and makes the
    source `UNPARSEABLE`.
  - The verdicts reach the ingest through `/3` as it stands; the contract has
    no member for the options themselves.
- **Where it shows.** An SDK agent in a scanned repository shows up as shadow,
  or as registered once the register links it, like a LangGraph one.

### The free-text instruction question was asked once already

#3351 (closed) asked four questions before a free-text layer could sit above
the compose form. Where is the text recorded? Does it pass the AI Guard? Which
model, and is that a sub-processor question? What happens when the text cannot
be resolved? A tenant-written agent brief is the same kind of layer, so Route A
has to answer the same four questions. It does, in *Decisions for the owner*
below.

## What the Claude Agent SDK is, as documented on 2026-10-24

Sources: the Agent SDK pages under `https://code.claude.com/docs/en/agent-sdk/`
(overview, typescript, hosting, secure-deployment, permissions, hooks,
custom-tools, mcp, subagents, skills, claude-code-features, sessions,
session-storage, cost-tracking), the sandboxing page and the
`anthropics/claude-agent-sdk-typescript` CHANGELOG. Package:
`@anthropic-ai/claude-agent-sdk`.

**It runs a subprocess per run.** "When your code calls `query()`, the SDK
spawns a separate `claude` CLI process and talks to it over stdio. That
subprocess owns the shell, the working directory, and the JSONL session
transcripts on local disk" (hosting). The binary is a native Claude Code
executable shipped through npm `optionalDependencies` and pinned to the SDK
version. An install with `--omit=optional` gets no binary. Our image runs
`npm prune --omit=dev` only, so it would ship. There is no documented
in-process loop. Custom tools *are* in-process: an SDK MCP server "runs
in-process inside your application".

**Resource guidance.** "1 GiB RAM, 5 GiB disk, and 1 CPU per agent is a
reasonable starting point… Memory usage grows with session length and tool
activity" (hosting). No cold-start figure is published. `startup()` and the
alpha `prewarm()` pre-spawn a process. "A session does not time out on its
own", so the wall clock is ours to enforce.

**It is permissive by default, and every default has to be turned off.**

- Built-in tools are on: Bash, Read, Edit, Write, Glob, Grep, WebFetch,
  WebSearch, Agent and Skill. `tools: []` removes every built-in and leaves MCP
  tools untouched (custom-tools).
- `settingSources` defaults to `["user","project","local"]`. That loads
  `~/.claude` settings, CLAUDE.md, rules, hooks, skills and `.mcp.json` from the
  host and the working directory. `settingSources: []` turns those off.
- **Even with `settingSources: []`, four things still load** (claude-code-features):
  managed policy settings; server-managed settings fetched for an
  organisation credential; `~/.claude.json` (moved with `CLAUDE_CONFIG_DIR`);
  auto memory (off with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`); and claude.ai MCP
  connectors (off with `strictMcpConfig: true`). The page says it plainly: "Do
  not rely on default `query()` options for multi-tenant isolation."
- `allowedTools` *auto-approves* and "does not restrict Claude to only these
  tools". Restriction is `tools` / `disallowedTools`.

**Permission evaluation order** (permissions): hooks → deny rules → ask rules →
permission mode → allow rules → `canUseTool`. A hook's deny "applies even in
`bypassPermissions` mode". "Auto-approved tools never reach `canUseTool`", and
under `dontAsk` the callback is not called at all. So `canUseTool` is not a
safe gate on its own. A `PreToolUse` hook with no matcher, ahead of
everything, is.

**Hooks** fire for subagent tool calls too (input carries `agent_id`). The useful
ones here: `PreToolUse` (deny, or `defer` to end the turn with
`stop_reason: "tool_deferred"` and resume later), `PostToolUse`,
`SubagentStart`/`SubagentStop`, `PreCompact`/`PostCompact`, `Stop`. A timed-out
`PreToolUse` blocks the call.

**Skills are files.** "The SDK does not have a programmatic API for registering
skills" (skills). They must exist as `.claude/skills/<name>/SKILL.md` under a
directory the session reads, or inside a local plugin directory.

**Sessions are local JSONL** under `$CLAUDE_CONFIG_DIR/projects/`.
`persistSession: false` keeps a session in memory. Cross-host resume needs a
`SessionStore` (`append` + `load`), and "the SDK never deletes from your store
on its own".

**The sandbox covers Bash only.** "Claude's file tools, MCP servers, and hooks
run outside it" (sandboxing). It needs `bubblewrap` and `socat` on Linux, and it
is not an isolation boundary for a multi-tenant host.

**What it reports.** A typed `SDKMessage` stream: `system/init` (the effective
tools, MCP server status, model, permission mode and `apiKeySource`),
`assistant`, `user`, `stream_event` with `includePartialMessages`, and `result`.
The result carries `num_turns`, `total_cost_usd`, `usage`, per-model
`modelUsage` and `permission_denials`. Its error subtypes are `error_max_turns`,
`error_max_budget_usd`, `error_during_execution` and
`error_max_structured_output_retries`. The cost figures are "client-side
estimates, not authoritative billing data" (cost-tracking).

**Terms and naming** (overview). Use is under Anthropic's Commercial Terms,
"including when you use it to power products and services that you make
available to your own customers". "Unless previously approved, Anthropic does
not allow third party developers to offer claude.ai login or rate limits for
their products": the worker authenticates with an API key or a cloud
credential, never a person's claude.ai login. A product may say "Claude Agent",
or "{Name} Powered by Claude". It may not call itself "Claude Code" or look
like an Anthropic product.

## How it would sit in Inflect (Route A)

Route A is three pieces. The builder is the part the customer sees, and the
other two are invisible to them.

```
  /agents/[agentId] → "Behaviour" tab            (frontend, no CLI)
        │  AgentProfileVersion: instructions, tools ⊆ grants, skills, model tier, trigger
        ▼
  startWorkflowRun(ctx, 'agent-profile:<id>@v<n>')     ← budget, concurrency, registration gate,
        │                                                 skill pins, profile pin, audit row
        ▼
  selectRunDriver → 'claude-agent-sdk'                  ← env switch ∧ tenant mode ∧ implemented ∧ asked
        ▼
  src/lib/agentic/claude-sdk/execute.ts
        query({ prompt, options: lockedOptions(run) })   ← one subprocess, per-run config dir, no built-ins
             │ tool call                    │ assistant message
             ▼                              ▼
   in-process MCP server "inflect"     MODEL_CALL step + Art 12 row + guard on the text
   (one tool per resolved grant)
             ▼
   runGuardedTool → runReadTool / runProposeTool        ← the funnel, unchanged
```

### The agent profile, which is the thing the customer builds

A new versioned, append-only model beside the register, `AgentProfile` →
`AgentProfileVersion`. It holds what the agent should *do*, never what it may
*reach*.

| Field | Bound by |
| --- | --- |
| Instructions (free text) | encrypted (Epic B manifest), `sanitizePlainText`, scanned at save by the skill text scan (`flue/skills/text-scan.ts`), size-capped |
| Tools | a subset of the agent's existing `RegisteredAgentTool` grants. The profile can only narrow, so a tool the register has not granted cannot be picked |
| Skills | the shipped corpus plus the tenant's APPROVED skills, through the existing mount gate |
| Model tier | a deployment allowlist (for example "balanced" or "deep"), never a free model id |
| Effort, max turns | bounded by `ENGINE_CAPS` / `resolveRunCaps` |
| Output | answer only, or answer plus proposals. "Answer only" sets `readOnly`, which withholds the propose surface the way `readOnly: true` does today |
| Trigger | the Ask page designation, an automation rule's `INVOKE_AGENT`, or a schedule |

A version runs only once someone other than its author approves it. That is
the tenant-skill rule (#3680) applied to instructions. A run pins the profile
version and the hash of its decrypted instructions, write-once, the way
`WorkflowRun.mountedSkills` pins skills. Rule 4 of the agentic roadmap carries
over: instructions teach, they never grant.

A profile version compiles to a synthetic `WorkflowDefinition` keyed
`agent-profile:<profileId>@v<n>`, so admission, caps, budget, concurrency,
the ledger, replay and the runs tab all apply without a parallel path. The
registry lookup in `startWorkflowRun` needs a second, tenant-scoped source for
those keys, and that lookup must refuse a profile from another tenant by
construction.

The builder is engine-neutral. The same profile can run on this driver, on
the Tool Runner driver (`docs/claude-tool-runner-design.md`) or on Flue. That
neutrality is deliberate, because Route A's engine choice is decision 1,
which Step 4a can confirm or overturn.

### The locked options builder

One function, `lockedOptions(run)` in `src/lib/agentic/claude-sdk/options.ts`,
builds every `query()` option. Nothing else in `src/` may call `query()`. A
guard pins both facts and the values below, the way
`tests/guards/flue-refused-capabilities.test.ts` pins Flue's import surface.

| Option | Value | Why |
| --- | --- | --- |
| `tools` | `[]`, or `['Skill']` when skills are mounted | no Bash, file, web or Agent built-ins: the refused-capability rule Flue already lives under |
| `mcpServers` | `{ inflect: createSdkMcpServer({ tools: resolved }) }` only | the resolved, narrowed tool set and nothing else |
| `allowedTools` | the exact `mcp__inflect__<tool>` names | auto-approve our own tools; never a wildcard |
| `disallowedTools` | `['Agent', 'Agent(fork)', 'WebFetch', 'WebSearch', 'Bash']` | belt over `tools: []` |
| `permissionMode` | `'dontAsk'`, set explicitly | the default changed in SDK 0.3.302; an unset mode is a version-dependent mode |
| `hooks.PreToolUse` | one catch-all hook, no matcher | denies any tool not in the resolved set, asks the kill switch and charges the run budget; hooks run first and their deny cannot be overridden |
| `settingSources` | `[]` | nothing from the host |
| `strictMcpConfig` | `true` | no claude.ai connectors |
| `env` | a minimal, built map: API key, `ANTHROPIC_BASE_URL` / workspace header, `CLAUDE_CONFIG_DIR=<per-run tmp>`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, `CLAUDE_CODE_FORK_SUBAGENT=0` | TS `env` *replaces* the subprocess environment, so the worker's own secrets never reach the child |
| `cwd` | an empty per-run temp directory, removed in `finally` | no repository, no CLAUDE.md |
| `persistSession` | `false` | `WorkflowRun` is the system of record; no transcript on disk |
| `systemPrompt` | a string: Inflect's fixed preamble + the pinned profile instructions, fenced and labelled | never the `claude_code` preset, which describes a coding agent. Omitting it gives a minimal prompt that the docs say "omits… its security and safety instructions" |
| `model`, `effort` | from the profile's tier, via the residency resolver | |
| `maxTurns`, `maxBudgetUsd` | from `resolveRunCaps` | backstops; the run budget charged in the hook is the primary cap |
| `abortController` | wired to the run's wall clock, the kill switch and SIGTERM drain | "a session does not time out on its own" |
| `includePartialMessages` | `false` | per-message granularity is what the ledger needs |

Residency comes out of this better than it does for Flue. The model endpoint is
a per-run `env`, so concurrent runs cannot race on a process-wide provider. The
limit is protocol: the SDK speaks the Anthropic API only. A `LOCAL_ONLY`
tenant is served only if `AI_LOCAL_BASE_URL` speaks that protocol. Otherwise
it is refused with a named reason, never sent externally. That is the same
refuse-not-downgrade rule `flue/model-selection.ts` applies.

### Every Inflect control, mapped to an SDK mechanism

| Inflect control | Mechanism in this driver |
| --- | --- |
| The funnel decides | each in-process tool's handler is `runGuardedTool(inv, name, args, toolUseID, review, origin)`, exactly as Flue's are |
| Advertised set = grant ∩ card ∩ scope ∩ ceiling | `offerToolSet` output, with a builder that hands each tool over as a Zod raw shape, becomes the SDK server's tool list. Tool search should be off for it (`alwaysLoad: true`), so the model sees the whole bounded set |
| Kill switch every turn | the `PreToolUse` hook calls `resolveKillState` and denies. The stream loop also checks on every `assistant` message and aborts |
| Run caps | charged in the `PreToolUse` hook through `createRunBudget`. `maxTurns` / `maxBudgetUsd` sit behind it |
| `MODEL_CALL` step + Art 12 decision row | one per `assistant` message from the stream. `result.modelUsage` reconciles the totals at the end |
| Guard on model free text | **new, and better than Flue.** The assistant text is visible in the stream, so it can be egress-scanned before it becomes the run's answer. Flue's hook could not see it |
| `TOOL_CALL` step | written inside the tool handler wrapper, as Flue's `wrapForLedger` does |
| Delegation | off in v1 (`Agent` disallowed). If adopted later: `agents` definitions whose `tools` are a subset of the parent's resolved set, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`, and fan-out counted in `SubagentStart`. Hooks fire inside subagents, so the same deny applies |
| Skills through the mount gate | resolved and hashed as today, then materialised as `SKILL.md` files from the pinned, decrypted, hash-checked text, and deleted in `finally`. **Where they are written is open.** Under `settingSources: []` the per-run `.claude/skills` is *not* discovered, because that path loads through the `project` source. A local plugin directory (`plugins: [{ type: 'local', path }]`) is the candidate, but the plugins page was not verified. Step 4a proves which path loads with nothing else enabled. The fallback is Inflect's own `activate_skill` tool in the `inflect` server, which keeps disclosure progressive and needs no files |
| Runtime-supplied tools reported | the `system/init` message lists the effective `tools` and `mcp_servers`. Assert it equals the resolved set plus `Skill`, and refuse the run if not. This turns `flue/runtime-tools.ts`'s measured-then-declared list into a per-run check |
| In-memory binding | `persistSession: false` and the per-run directory. The same ratified deviation as Flue: a run does not survive its worker process |

### What changes in Inflect's code

- `AGENT_DRIVERS` gains `'claude-agent-sdk'`. That brings a new env switch,
  `AGENT_DRIVER_CLAUDE_SDK`, which is opt-in and read like `AGENT_DRIVER_FLUE`,
  and a `DRIVER_IMPLEMENTED` entry. `resolveAgentDriver` generalises from
  "is it FLUE" to "which engine".
- `AgentDriverMode` gains `CLAUDE_SDK` **in two deploys**. The first teaches
  readers and writes nothing, because a Prisma client meeting an enum value it
  was not generated with fails the whole read. `AI_ADMIN` and `AccessReviewScope`
  were added the same way.
- **Done in Step 0a.** `startWorkflowRun` and `resumeWorkflowRun` ask
  `isReasoningEngine(driver)` for the registration gate, the skill pin and the
  worker hand-off. The new engine only has to be classified in its record, which
  `tsc` enforces.
- **Done in Step 0a.** The engine-neutral core is `src/lib/agentic/engine-tools/`:
  `offerToolSet`, `runGuardedTool`, `ReviewLatch` and the guard observers. The
  SDK reuses it as it is and supplies two things of its own:
  - a `ToolBuilder` that hands each tool over as a Zod raw shape (each MCP tool
    already carries `argsSchema: ZodType`);
  - a guard source prefix.
- `src/lib/agentic/claude-sdk/` mirrors `flue/`: `driver.ts` (plan or refuse,
  no SDK import), `execute.ts` (reached by dynamic `import()` only),
  `options.ts`, `tools.ts`, `hooks.ts`, `ledger.ts`.
- `docs/sub-processors.md`: the Anthropic row's agent-run purpose names this
  engine, and the data category grows by "tenant-authored agent instructions".
  No new sub-processor, and no new host: it is the same Messages API, key and
  workspace header.

### Operational cost, stated before anyone builds it

One run is one subprocess. Anthropic's 1 GiB / 1 CPU starting point, against
a worker that runs BullMQ at concurrency 5 on the production VM, means the
engine's concurrency must be capped on its own (`run-concurrency-policy.ts`
already exists) and sized from measured peak RSS, not from the docs. The spike
in Step 4a measures three things: peak RSS for a ten-turn run with twenty tools,
time to first token with and without `startup()`, and the binary's image-size
cost.

## Route B: agents the customer runs, set up without a CLI

Some customers will build on the Agent SDK themselves, because their agent
needs the customer's own files, shell or network. Inflect cannot host that, and
should not. It can make governing it a few clicks:

1. **Connect an agent you run**, on the agent's detail page. Inflect mints an
   API key bound to the agent (the existing `TenantApiKey.agentId` and
   `maxAutonomyLevel`), scoped `mcp:read` (plus `mcp:propose` when the agent
   holds a propose grant) and each granted tool's own resource scope, and shows
   it once. The resource scopes are the owner's decision of 2026-10-29 on
   #4155: `/api/mcp` checks a tool's resource scope on top of `mcp:read`, so a
   key with `mcp:read` alone reaches no tool. Built in Step 3a.
2. It generates the **SDK configuration** for that agent, in TypeScript and
   Python: `mcpServers.inflect = { type: 'http', url: '<origin>/api/mcp',
   headers: { Authorization: 'Bearer <key>' } }`, `allowedTools` set to the
   agent's exact granted tool names, and the hardening above (`settingSources:
   []`, `strictMcpConfig`, an explicit `permissionMode`). Copy, paste, run.
   The customer types no `curl` and no `ant`.
3. The harness scanner's `code` source recognises the SDK
   (`@anthropic-ai/claude-agent-sdk`, Python `claude_agent_sdk`; Step 3b, #4156):
   `query(...)` / `ClaudeSDKClient(...)` call sites, their `tools`,
   `allowedTools`, `mcpServers`, `permissionMode`, `settingSources`, `agents`
   and `hooks`. An SDK agent in a scanned repository shows up as shadow or
   registered like a LangGraph one. Its options are also harness-ladder
   evidence, as NOT MET verdicts against H2/H3: `bypassPermissions`, host
   settings loaded, a wildcard `allowedTools`, a callable `Bash` or `WebFetch`,
   and no hook. They are never gates, because the ladder is report-only.
   "What the harness scanner recognises" above has the owner's mapping.

Every call still lands on `/api/mcp`, so the funnel's authorization applies
unchanged: kill switch, grants, policy card, autonomy ceiling, audit,
propose-not-commit. Route B adds no authority, no sub-processor and no engine.

One AI Guard slice comes with it and one does not. `runGuardedTool` guards
Flue's tool calls on both sides: egress on the arguments, untrusted input on the
results. Since #4111 the direct MCP route applies the first one:
`assertMcpArgumentsAllowed` (`src/lib/mcp/argument-guard.ts`) scans a read
tool's arguments before the funnel. A proposal is guarded at the queue, because
`createAgentProposal` scans each item. A read's *result* is not scanned on this
route. For a customer-hosted agent, the injection risk in a result lands in the
customer's own model, which Inflect does not run (decision 6 below).

## Route C: Managed Agents

Covered in `docs/claude-managed-agents-design.md`. The short reason it is not
the first route: Anthropic stores the agent configuration and the session
history, and the Managed Agents overview says it "is not currently eligible for
Zero Data Retention or HIPAA Business Associate Agreement (BAA) coverage".

It is still on the plan, in both places it can run. Phase 5 runs it in the
customer's own Anthropic workspace. Phase 6 runs it in Inflect's organisation,
for tenants with no Anthropic account of their own. The owner decided on
2026-10-24 that Phase 6 does not wait for ZDR or EU storage. It waits only for
the sub-processor change policy's 30-day notice, and for each tenant to opt in.

## Decisions for the owner

1. **Which engine runs the builder's agents first.** **Decided (owner,
   2026-10-25): the Tool Runner** (`docs/claude-tool-runner-design.md`,
   decision 1). Phase 2 builds it, and Phase 4 stays conditional. The Agent SDK
   brings hooks, a permission engine, subagent definitions and compaction. It
   costs a subprocess and a lockdown whose every line exists to turn a default
   off. The Tool Runner brings an in-process loop with nothing to turn off. This
   driver stays the candidate second engine, adopted only if a profile needs
   something the Tool Runner engine cannot give it, such as hook-based deferral
   of a call to a human.
2. **The four #3351 questions, for instructions instead of compose text.**
   **Decided (owner, 2026-10-25): all four answers below are accepted as
   written.** Step 1a builds to them. *Recorded where:* encrypted on `AgentProfileVersion`, its hash pinned on every
   run, and rendered as text, never markup. *Through the AI Guard:* scanned at
   save; at run time it is the operator's own fenced block, never mixed into
   tool output. *Which model:* the existing Anthropic sub-processor; naming the
   new data category on the row is proposed as sufficient, matching the
   2026-10-18 decision for Flue, and accepted as such. *Unresolvable:* a
   profile asking for a tool the agent is not granted is refused at save, never
   silently dropped at run.
3. **Who approves a profile version.** **Decided (owner, 2026-10-25):
   `admin.agent_registry`, with author ≠ approver**, as for tenant skills. The
   rule is held in the usecase and by a CHECK. A new key would have been cleaner,
   at the price of a custom-role migration, and was declined.
4. **Delegation in v1.** **Decided (owner, 2026-10-30): on, inline and
   subset-only** (it was proposed off). A profile version may define
   sub-agents inline, each with its own instructions and a subset of the
   version's tools and skills, approved with the version. Delegation is one
   level deep: a sub-agent cannot delegate. Every tool call a sub-agent makes
   goes through the funnel under the parent agent's identity, labelled with the
   sub-agent, and charged to the parent run's caps. It is built first on the
   Tool Runner engine, as Step 2e (`docs/claude-tool-runner-design.md`), after
   2H. An engine built later (Phases 4 to 6) carries the same inline definition;
   how it maps it is decided in that engine's own steps.
5. **Branding.** The builder says "Agent", and names Claude as "Powered by
   Claude" where the model is shown. It never says "Claude Code". **Decided
   (owner, 2026-10-30): as written.**
6. **The AI Guard on the direct MCP route.** **Done in #4111:** the egress
   slice on a read's arguments runs on the route, the same check as
   `runGuardedTool`'s step 1. The result scan is left to the engine that
   consumes the result, because only Inflect's own engines put a result into
   Inflect's model.

7. **Whether a profile runs on Flue in Phase 1.** **Decided (owner,
   2026-10-26): no.** Flue builds its prompt from a workflow's description and
   steps, so it would run a profile while ignoring the instructions. Admission
   therefore refuses a profile on every engine whose `runsProfiles` entry is
   false, which is every engine until Phase 2's Tool Runner sets its own. It
   also keeps "tenant-authored agent instructions" off the Anthropic
   sub-processor row until Step 2c, where the roadmap records it.

8. **How Phase 1's production evidence is gathered.** **Decided (owner,
   2026-10-26): a per-tenant allowlist.** `AGENT_PROFILES` opens the surface
   to every tenant, and Step 1H's evidence needs it in one proving tenant only.
   `AGENT_PROFILES_TENANTS` names the tenants that get it. It is emptied once
   the evidence is recorded.

## Roadmap (future direction)

This section is the executable plan for all three Claude agent designs. Each
phase is broken into pull-request-sized steps. Each step has a prompt for a
fresh Claude Code session and a hardening checklist its pull request must
satisfy, and each phase ends with a hardening step of its own. The format
follows `docs/legacy-access-recertification-phases.md`, including the lessons
recorded there.

The phases that belong to this document are 0, 1, 3 and 4. Phase 2 is in
`docs/claude-tool-runner-design.md`; phases 5 and 6 are in
`docs/claude-managed-agents-design.md`. The global rules, the definition of
done and the evidence table below bind all three.

### How to use this roadmap

- **One step, one pull request, one fresh session.** Paste the step's prompt into
  a new Claude Code session on a new branch. Each prompt is self-contained: it
  says what to read, so it needs nothing from an earlier conversation.
- **The hardening checklist is the acceptance test.** The session copies it into
  the pull-request body and ticks each item beside the test that proves it. An
  item with no test stays unticked, and a pull request with an unticked item is
  not done.
- **Every phase ends with its hardening step**, suffixed `H`. It starts only when
  every other step of the phase is merged, and the next phase starts only when
  it is merged. It looks at the phase as a whole: what each step's checklist
  cannot see, because the defect lives between two steps or only appears when
  the code runs for real.
- **Never start a step before its dependencies are merged.**

### The phases

| Phase | Name | Steps | Defined in | Depends on |
| --- | --- | --- | --- | --- |
| 0 | Foundations | 0a, 0b, 0c, 0d, 0H | this document | — |
| 1 | Agent builder | 1a, 1b, 1H | this document | 0H |
| 2 | Tool Runner engine | 2a, 2b, 2c, 2d, 2H (2x is independent; 2e follows 2H) | `docs/claude-tool-runner-design.md` | 1H |
| 3 | Connect agents customers run | 3a, 3b, 3H | this document | 0H (3a also needs 0d) |
| 4 | Agent SDK engine (conditional) | 4a, 4b, 4c, 4H | this document | 2H, and a profile that needs it |
| 5 | Managed Agents in the customer's workspace | 5a, 5b, 5c, 5d, 5e, 5H | `docs/claude-managed-agents-design.md` | 2H, 3H |
| 6 | Managed Agents hosted by Inflect | 6a, 6b, 6c, 6H | `docs/claude-managed-agents-design.md` | 5b for the notice (6a), 5d for the build (6b), and the notice's 30-day window for activation (6c) |

Phases 2 and 3 can run in parallel: 3 depends only on Phase 0.

| Step | Title | Depends on | Change class |
| --- | --- | --- | --- |
| 0a | Engine-neutral tool core | — | Standard (delivered by #4176) |
| 0b | Driver conformance suite | 0a | Standard |
| 0c | Agent engines settings page | — | Significant — route permission (delivered by #4181) |
| 0d | `/api/mcp` per-key budget and argument guard | — | Significant — security middleware (delivered by #4111) |
| 0H | Phase 0 hardening | 0a–0d | Standard |
| 1a | Agent profile model and usecases | 0H | Significant — schema migration, new encrypted column |
| 1b | Builder UI | 1a | Standard |
| 1H | Phase 1 hardening | 1a, 1b | Standard |
| 3a | Connect wizard | 0H | Significant — a new path that mints credentials |
| 3b | Scanner recogniser for the Agent SDK | 0H | Standard |
| 3H | Phase 3 hardening | 3a, 3b | Standard |
| 4a | Spike | 2H | Standard (no product path) |
| 4b | Agent SDK driver, reader-only | 4a, owner decision | Significant — enum value, new runtime dependency |
| 4c | Turn the Agent SDK engine on | 4b deployed | Significant — enables third-party code to run agents |
| 4H | Phase 4 hardening | 4b, 4c | Standard |

Change classes follow `docs/change-management-policy.md`.

<!--
    NO STATUS COLUMN, on purpose. `docs/legacy-access-recertification-phases.md`
    explains why: a status stored beside its source is falsified by the very merge
    that writes it, and concurrent steps all conflict on the same rows. A step's
    pull-request number is the fact; derive its state from GitHub.
-->

### Global rules

These bind every step in all three documents. The prompts point here rather than
restating them.

1. **The design document is the source of truth for intent.** If the code
   contradicts a fact in it, the code wins and the pull request says so. If a step
   would have to deviate from the design, stop and ask.
2. **The engine decides what to try; the funnel decides what is permitted.** Every
   tool call an engine makes goes through `runGuardedTool` → `runReadTool` /
   `runProposeTool`. An engine module contains no permission check, no usecase call
   and no Prisma call. If one seems needed, it belongs in the funnel.
3. **Authority only narrows.** A profile's tools are a subset of the agent's grants.
   Instructions teach and never grant (the agentic roadmap's rule 4). A subagent's
   tools are a subset of its parent's resolved set. Nothing a tenant writes can
   widen a grant, a ceiling or a scope.
4. **Fail closed, and never silently.**
   - A refusal happens before the run row exists wherever it can, carries a named
     reason, and never degrades to a different engine or a stub.
   - Zero is never complete: a count that gates a claim also asserts the
     population is non-empty.
5. **Third-party content is untrusted.** That covers tool results, tenant-authored
   instructions and skills, and anything an Anthropic API returns. The AI Guard
   runs on a model's proposed arguments and on every tool result that will enter
   Inflect's model. Model free text is egress-scanned before Inflect uses it.
6. **Nothing new is stored at Anthropic without the sub-processor step.**
   - Hosted engines send Messages API calls only: `thread: false` on the Tool
     Runner, `persistSession: false` and no session store on the Agent SDK.
   - Managed Agents stores data by design, and is gated in its own phases.
   - A pull request that sends a new data category updates `docs/sub-processors.md`
     in the same diff.
   - A new environment variable is triaged in `docs/sub-processors.md` or
     allowlisted with a reason, or `sub-processor-coverage` fails.
7. **Every new tenant table gets:**
   - the RLS migration triple (`docs/rls-tenant-isolation.md`);
   - a `tenantId`-leading index, with each foreign key indexed;
   - a two-tenant behavioural test registered in
     `tests/guardrails/tenant-isolation-forward-lock.test.ts`;
   - a row in `docs/data-retention.md`;
   - a decision in `src/lib/security/encrypted-fields.ts`.
8. **Every new route** carries a literal `requirePermission(...)` with a rule in
   `src/lib/security/route-permissions.ts`. Admin routes are listed in
   `tests/guardrails/admin-route-coverage.test.ts`. No route is reachable without
   authorization (`api-route-has-some-authorization`).
9. **Migrations are additive and forward-only.**
   - A new enum value ships in two deploys: readers first, the first writer after.
     A Prisma client that meets a value it was not generated with fails the whole
     read.
   - A step with a migration or a security-boundary change is Significant: its
     pull request carries a rollback plan and a risk assessment.
10. **UI goes through the platform.**
    - Use the shells and primitives (`EntityDetailLayout`, `Modal` / `Sheet`,
      `FormField`, `Combobox`, `ConfirmDialog`, `CopyButton`).
    - Strings go in `messages/en.json` **and** `messages/bg.json`
      (`i18n-completeness`).
    - Mutating E2E specs use the `isolatedTenant` fixture.
11. **Test behaviour, not shape.**
    - Each step ships tests that fail when the behaviour regresses, and the
      checklist names a mutation that proves it.
    - A new guard is named for its invariant, never for the step
      (`no-epic-named-ratchets`).
    - Source scans take their population from git (`tests/helpers/repo-files.ts`).
    - Assertions bind to the construct they name (`tests/helpers/source-blocks.ts`).
12. **Naming.** The product says "Agent", and "Powered by Claude" where the model is
    shown. It never says "Claude Code" or "Claude Cowork".
13. **Stop and ask, do not improvise, if a step seems to need any of these:**
    - a built-in shell, file, web or subagent tool in an engine Inflect hosts;
    - a model call that does not go through the engine's residency resolver;
    - customer data stored at Anthropic beyond Messages API calls, outside Phases
      5–6;
    - a new permission key, unless the step names it;
    - a change to what `runGuardedTool` refuses or records;
    - widening any grant, ceiling, scope or rate limit.

### Definition of done

Every step, without exception:

- one branch and one pull request, driven to green and merged through the merge
  queue under the working agreements in `CLAUDE.md`;
- the step's hardening checklist in the pull-request body, every item ticked beside
  the test that proves it;
- an implementation note in `docs/implementation-notes/<date>-<slug>.md`. It needs no
  classification entry, because that subtree is classified by path;
- anything the step made true moved from the owning design document's Roadmap into
  its Current state, so the document stays accurate;
- `CLAUDE.md`'s section "Claude agent engines", created in step 0a, updated with any
  invariant the step introduced. Every later session loads it automatically.

### Operational evidence: what has actually run

The hardening checklists ask "is this built correctly?". This table asks "has it
ever run?", and names the artefact (a run id, a row id, a metric value, a date) or
says plainly that there is none. An unreached code path passes every test written
for it, which is the lesson #3578 records. **A green test is not an entry here.**
Each phase's hardening step fills its row.

| Phase | Has it run in production? | Evidence |
| --- | --- | --- |
| 0 — Foundations | yes, 2026-10-26 | Deployed at 19:04:37 UTC on 2026-10-25, when Watchtower rolled the `ced48e0` publish. Before that, every image publish after 04:28 had been cancelled by the next push (#4280). **`/api/mcp` limiting**, about 19:25 UTC: a probe of 610 unauthenticated requests drew 600 `401` and 10 `429`, and exactly 10 `rate-limit.blocked` lines, all `mcp-ip`, none `api-mutation`. **A Flue run:** the first start after the deploy answered 500, because the image did not carry the skill corpus (#4301, fixed by #4302). After the fix, `access-posture` run `cmvp38v9d000001o5526qt04h` completed on 2026-10-26: recorded `FLUE`, 1 `MODEL_CALL` and 2 `TOOL_CALL` steps, all `DONE`, in 16 s. The baseline, `cmujpuc84000001pgl3rdy9ud` (2026-09-27), had 1 `MODEL_CALL` and 5 `TOOL_CALL` steps. |
| 1 — Agent builder | no | — |
| 2 — Tool Runner engine | no | — |
| 3 — Connect agents customers run | no | — |
| 4 — Agent SDK engine | no | — |
| 5 — Managed Agents, customer workspace | no | — |
| 6 — Managed Agents, Inflect-hosted | no | — |

---

### Phase 0 — Foundations

Make the engine seam ready for more than Flue. #4111 closed the two gaps on
`/api/mcp` first (Step 0d). #4176 then delivered the engine-neutral tool core
(Step 0a), #4220 the driver conformance suite (Step 0b), and #4181 the Agent
engines section (Step 0c). #4248 hardened the phase (Step 0H). **Phase 0 is
built, mutation-proved and observed in production.** Its `/api/mcp` limiting was
observed on 2026-10-25, and a Flue run completed after it on 2026-10-26, once
#4302 shipped the skill corpus in the image (#4301). See the Operational evidence
table.

#### Step 0a — Engine-neutral tool core

Delivered by #4176 (#4137). The work done:

- The scope, autonomy and read-only narrowing (`offerToolSet`), the review
  latch and the guarded call (`runGuardedTool`) moved to
  `src/lib/agentic/engine-tools/`. ESLint refuses any engine import there.
- An engine now supplies only a `ToolBuilder` and its guard source prefix.
- Flue passes `'flue'`, so its guard sources are byte-identical to before.
- `startWorkflowRun` and `resumeWorkflowRun` ask `isReasoningEngine(driver)`
  for the registration gate, the skill pin and the worker hand-off.

The Current state section "The engine-neutral tool core" describes the result.
The design and the decisions are in
`docs/implementation-notes/2026-10-25-engine-neutral-tool-core.md`. The step has
no prompt, and 0H checks it together with the rest of the phase.

#### Step 0b — Driver conformance suite

Delivered by #4220 (#4138). The work done:

- `tests/helpers/driver-conformance.ts` holds two engine-agnostic tables. The
  run table had ten scenarios; Step 2d added an eleventh,
  `refused-skill-never-reaches-the-model`. The admission table has one scenario, checked
  for three unvouched standings with a vouched positive control. An engine
  supplies an adapter, and the scenarios assert only on what the adapter
  observes.
- A variance names a stronger property and the owner decision accepting it, or
  the suite fails. Flue declares none.
- Flue runs the run half in the `flue` project
  (`tests/flue/driver-conformance.test.ts`). The real boot, driver, tool core,
  AI Guard and Art 12 writer run behind faux model transports. Flue runs the
  admission half against the database
  (`tests/integration/driver-conformance-admission.test.ts`).
- Flue failed two scenarios as first written, and neither was weakened. The
  kill switch was asked only before boot and at the tool boundary (#4196). It
  was fixed first, in #4201. The ledger scenario asked for one `MODEL_CALL` step
  per model call (#4197). The owner chose the less restrictive bar on
  2026-10-25: every model call counted by a `MODEL_CALL` step that names how
  many calls it covers. That scenario changed for every engine.

The Current state section "The driver conformance suite" describes the result.
The design and the decisions are in
`docs/implementation-notes/2026-10-25-driver-conformance-suite.md`.

#### Step 0c — Agent engines settings page

Delivered by #4181 (#4139). The prompt's premises differed from the code in two
places. The code won, and the owner decided both on 2026-10-25:

- **Reading the setting needed a route permission change.** The read was
  OWNER-only. `GET /admin/agent-driver` now takes `admin.view`, and the PUT
  stays `admin.tenant_lifecycle`. The AI features page gates each section rather
  than the whole page.
- **A second control already existed.** `FlueEngineCard` on Admin →
  Integrations toggled the same column. It was removed, and its six-term
  checklist moved into the section, for owners.

The result is described in the Current state under "The driver seam". The design
and decisions are in
`docs/implementation-notes/2026-10-25-agent-engines-settings-section.md`. The
step has no prompt left to run. 0H checks it together with the rest of the
phase.

#### Step 0d — `/api/mcp` per-key budget and argument guard

Delivered by #4111. The rate limit is keyed on the verified `apiKeyId` and charged
per JSON-RPC message, behind a per-IP ceiling of its own. Read-tool arguments pass
the AI Guard's egress scan. The design and the tests are in
`docs/implementation-notes/2026-10-24-mcp-per-key-rate-limit-and-argument-guard.md`.

0H's re-read found four defects in it (#4205), fixed by #4210:
- the key is now charged before the invocation is built;
- a malformed request costs one unit;
- the argument guard runs after the tool resolves and passes authorization;
- a refusal no longer names the guard's rules.

The scanner's own gaps (#4206) are older than the step. #4212 fixed them: keys
are scanned, and content past depth 64 is refused.

#### Step 0H — Phase 0 hardening

Delivered by #4248 (#4141):

- **The adversarial read** found the run-engine label (fixed by #4285, `recordedModeOf`) and six
  rendering faults in the Agent engines section, each with a test.
- **#4205 and #4206** were found by the read and fixed in #4210 and #4212.
- **#4224** was filed against Step 2b.
- **The mutation sweep** turns each conformance scenario red with exactly its
  own mutation.

- **The production evidence** is in the Operational evidence row for Phase 0. The
  owner read the VM, because the session's `gcloud` credentials were refused. The
  first Flue run start answered 500, which found #4301 (fixed by #4302).

Details are in `docs/implementation-notes/2026-10-25-phase-0-hardening.md`.

**Goal.** Prove Phase 0 as a whole: Flue runs exactly as before on the new core,
the conformance suite bites, and the MCP changes behave in production.

```text
You are implementing Step 0H of the roadmap in docs/claude-agent-sdk-design.md:
the hardening step for Phase 0. Steps 0a, 0b, 0c and 0d (#4111) are merged. Read
the roadmap's "Global rules", "Definition of done", "Operational evidence" and all
of Phase 0, and each step's implementation note.

Goal: evidence that Phase 0 is sound end to end, and that it has run.

1. Re-read the merged diffs of 0a–0d together, adversarially. Look for what each
   step's checklist could not see: a 'flue' literal the sweep missed, a guard
   source string that changed, a conformance scenario that passes for a reason
   other than the control, a page state the API can produce but the page does not
   render. Fix what you find in this pull request, with a test each.
2. Mutation sweep: for each conformance scenario, apply the mutation its checklist
   names, run the suite, record which scenario went red, and revert. Put the table
   in the implementation note.
3. Production evidence, read-only, per CLAUDE.md's "Production VM" section (never
   print secrets):
   - one Flue run in the proving tenant after 0a deployed: its WorkflowRun id and
     its MODEL_CALL and TOOL_CALL counts, compared with a run of the same workflow
     before 0a;
   - from the app logs, the count of `rate-limit.blocked` lines by scope
     (`mcp-api-key`, `mcp-ip`) since #4111 deployed, and that `api-mutation` no
     longer appears for /api/mcp.
   If a run cannot be made, say so in the evidence table; never fill it from a
   test.
4. Update the "Operational evidence" row for Phase 0, move what Phase 0 made true
   into the Current state of docs/claude-agent-sdk-design.md and
   docs/claude-managed-agents-design.md, and extend CLAUDE.md's "Claude agent
   engines" section with any invariant the phase introduced.

Deliver per the Definition of done.
```

**Hardening**

- [ ] The adversarial read is in the implementation note: what was looked for, what was found, and the test added for each finding.
- [ ] The mutation table lists every conformance scenario with the mutation applied and the scenario that went red. None is green under its mutation.
- [ ] The Phase 0 evidence row names a production run id with before and after step counts, or says plainly that no run was possible and why.
- [ ] Production logs show `/api/mcp` limited under `mcp-api-key` / `mcp-ip` and not `api-mutation`, with the count and the date.
- [ ] Both design documents' Current state sections describe Phase 0 as built, and their Roadmap sections no longer describe it as future work.

**Exit.** Phase 0 is built, mutation-proved and observed in production, and the documents say so.

---

### Phase 1 — Agent builder

The part a customer sees. They say what their agent should do inside the register
they already use, a second person approves it, and no engine is visible. The
builder ships behind an opt-in flag and stays off until Phase 2 gives it an
engine that can run a profile.

#### Step 1a — Agent profile model and usecases

Delivered (#4143). The model, usecases, routes, resolver and run pin are in
"Agent profiles" under Current state. One deviation from the prompt below was
an owner decision (decision 7): a profile resolved to Flue is refused too
(`PROFILE_ENGINE_CANNOT_RUN_PROFILES`), because no engine renders a profile's
instructions until Phase 2.

**Goal.** Store what an agent should do, versioned and approved, and compile an
approved version into a run Inflect can admit. Nothing runs it yet.

```text
You are implementing Step 1a of the roadmap in docs/claude-agent-sdk-design.md.
Read its "Global rules", "Definition of done" and "Step 1a", then the document's
sections "The agent profile, which is the thing the customer builds" and
"Decisions for the owner". Read how tenant skills are modelled and approved
(prisma/schema/agentic.prisma: TenantSkill, TenantSkillVersion;
src/app-layer/usecases/tenant-skills.ts) and follow that shape. Phase 0 is merged.

Before starting, check "Decisions for the owner" for decisions 2 and 3. If the
owner has recorded a decision different from the proposal, follow the decision.
If decision 3 (who approves) has no recorded answer, use admin.agent_registry
with author != approver, and say so in the pull request.

Goal: AgentProfile and AgentProfileVersion, their usecases and routes, and a
tenant-scoped resolver that turns an APPROVED version into a WorkflowDefinition.

1. Schema, in prisma/schema/agentic.prisma:
   - AgentProfile: one per RegisteredAgent, composite FK to (agentId, tenantId),
     and a currentApprovedVersion pointer as an Int, the AgentPolicyCard shape.
   - AgentProfileVersion: version Int; instructions (encrypted through the
     manifest); instructionsHash (hex SHA-256 of the sanitised text); toolNames
     String[]; skillRefs Json; modelTier (string pinned by a CHECK to the tiers
     the deployment offers); effort; maxTurns; outputKind (ANSWER_ONLY or
     ANSWER_AND_PROPOSALS); allowedTriggers String[] (ASK, AUTOMATION, TEST_RUN);
     status (DRAFT, SUBMITTED, APPROVED, REJECTED, RETIRED); authoredByUserId;
     decidedByUserId.
   - A CHECK that decidedByUserId differs from authoredByUserId.
   - A trigger that freezes every column of a decided version except the move to
     RETIRED. app_user holds no DELETE.
   - Migration additive. Follow global rule 7 in full.
2. Usecases in src/app-layer/usecases/agent-profiles.ts: create draft, edit (a new
   DRAFT version), submit, approve, reject, retire. On save: sanitizePlainText,
   a size cap, the skill text scan (src/lib/agentic/flue/skills/text-scan.ts)
   with refusal by rule id, and toolNames checked as a subset of the agent's
   current grants (refuse an ungranted tool by name, never drop it). Each act
   writes a logEvent row.
3. Routes under /api/t/[tenantSlug]/admin/agents/[agentId]/profile/..., each with
   a literal requirePermission and a rule in route-permissions.ts.
4. A resolver, resolveRunDefinition(ctx, workflowKey), used by startWorkflowRun in
   place of the direct getWorkflowDefinition call:
   - a key `agent-profile:<profileId>@v<n>` loads that APPROVED version inside the
     caller's tenant (RLS), and refuses anything else with a named reason;
   - any other key behaves exactly as today.
   The compiled definition asks for the tenant's permitted reasoning engine. A
   profile resolved to `static` is refused before the run row exists
   (PROFILE_NEEDS_REASONING_ENGINE). At run time the tools are the intersection
   of the version's toolNames and the agent's current grants, and each tool lost
   to a revoked grant is recorded as an omission.
5. WorkflowRun gains profileVersionId and profileInstructionsHash, both nullable
   and write-once by trigger, the way mountedSkills is pinned.
6. The whole surface is behind a new opt-in env flag, AGENT_PROFILES, read like
   AGENT_DRIVER_FLUE (only '1' and 'true' count). Triage it per global rule 6.

Tests: usecase tests for every refusal; a two-tenant test that tenant B cannot
resolve, run or read tenant A's profile by key; an integration test for the
author != approver CHECK and the freeze trigger; a test that a run pins the
version and hash.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] `instructions` is in `ENCRYPTED_FIELDS`, and a raw-SQL read of the column returns ciphertext (`v2:`), proven in an integration test.
- [ ] The author-≠-approver rule holds in the usecase and in the database: a raw `UPDATE` that sets `decidedByUserId = authoredByUserId` fails.
- [ ] A decided version cannot be edited by any role. The freeze trigger is proven by an integration test, including for the table owner.
- [ ] An ungranted tool is refused at save with its name. A grant revoked after approval narrows the run and records the omission, and never fails open.
- [ ] `agent-profile:` keys resolve only inside the caller's tenant: the two-tenant test is registered in `tenant-isolation-forward-lock`.
- [ ] A profile on the `static` engine is refused before `createSealedRun`. The test asserts that no `WorkflowRun` row exists afterwards.
- [ ] The text scan refuses each rule family from the injection corpus, `tests/integration/prompt-injection-corpus.test.ts` style, by rule id.
- [ ] `docs/data-retention.md` classifies both tables, `schema-index-coverage` passes, and the pull request has a rollback plan and risk assessment.
- [ ] With `AGENT_PROFILES` unset, every profile route answers 404 and nothing renders.

**Exit.** An approved profile version compiles into a run that `startWorkflowRun` admits or refuses with a named reason, inside one tenant only.

#### Step 1b — Builder UI

Delivered (#4144). The tab, the rejection reason and the builder's read are in
"Agent profiles" under Current state. Three deviations from the prompt below:

- **A schema migration.** Reject asks for a reason, and Step 1a had no column
  to hold it, so this step added `rejectionReason`. The step is Significant,
  not Standard.
- **Test run is disabled, with no start path.** A browser session carries no
  agent identity, and admission resolves only the approved version in force,
  so enabling Test run needs a route this step could not exercise. That route,
  the view's enabled state and the button's action are carried to Step 2c in
  `docs/claude-tool-runner-design.md`.
- **No Retire control.** The prompt does not ask for one, and an edit retires
  the open version already. Retiring the version in force stays an API act
  (`…/versions/:version/retire`).

**Goal.** A Behaviour tab where a tenant writes, submits, reviews, approves and
test-runs their agent's instructions.

```text
You are implementing Step 1b of the roadmap in docs/claude-agent-sdk-design.md.
Read its "Global rules", "Definition of done" and "Step 1b", Step 1a's
implementation note, and src/app/t/[tenantSlug]/(app)/agents/[agentId]/ in full
(AgentDetailClient.tsx and tabs/, especially SkillsTab.tsx and
TenantSkillEditorModal.tsx, which solve the same author-and-approve problem).
Step 1a is merged.

Goal: a "Behaviour" tab on the agent detail page, shown only when AGENT_PROFILES
is on.

1. The current approved version, read-only: instructions as text (never as
   markup), tools, skills, model tier, output kind, allowed triggers, approver
   and date.
2. An editor in a Sheet:
   - the instructions field, with a character counter against the 1a cap;
   - tool and skill pickers (Combobox) that list only the agent's granted tools
     and mountable skills;
   - model tier and output kind as RadioGroup;
   - allowed triggers as checkboxes.
   Saving creates a DRAFT; Submit moves it to SUBMITTED. Show refusals from the
   usecase by their reason, next to the field they concern.
3. Review: a user who may approve, and is not the author, sees the submitted
   version beside the approved one as a text diff, with Approve and Reject (with
   a reason).
4. Version history with each version's status, author and decider, and the
   instructions hash.
5. A "Test run" button for an approver on a SUBMITTED or APPROVED version. It
   starts a read-only run with the TEST_RUN trigger and opens it in the Runs tab.
   Until an engine that runs profiles is enabled, the button is disabled and says
   which engine setting it needs. No engine runs a profile in this step; the
   button's enabled path is exercised in Step 2c.
6. All copy in en.json and bg.json. Follow the action and destructive-action
   vocabularies in CLAUDE.md (Reject is a canonical destructive verb).

Tests: rendered tests (testid-first) for each state (no profile, draft,
submitted, approved, rejected, author viewing own submission); one E2E spec on
isolatedTenant that drafts, submits, and approves as a second user.

Deliver per the Definition of done.
```

**Hardening**

- [ ] Instructions render as text everywhere. A rendered test with `<img onerror>` in the instructions asserts that no element is created.
- [ ] The author never sees Approve on their own submission, and a crafted approve request from the author is refused by the usecase (test).
- [ ] The pickers cannot offer an ungranted tool. The test grants two tools and asserts the option list equals exactly those two.
- [ ] The Test run button's disabled state names the missing engine setting, and no run row is created while it is disabled.
- [ ] `i18n-completeness`, `i18n-adoption-ratchet`, `destructive-vocabulary` and `action-label-vocabulary` stay green.
- [ ] The E2E spec uses two users in one `isolatedTenant`, and its approve step asserts the audit row.

**Exit.** A tenant can write, review, approve and version an agent's behaviour in the product, with no CLI and no code.

#### Step 1H — Phase 1 hardening

Ships in two pull requests, because the production evidence needs code that has
to be deployed first. The first carries the per-tenant allowlist (decision 8),
the adversarial read and its tests, the corpus and purge tests, and the
invariants. The answers are in
`docs/implementation-notes/2026-10-26-phase-1-hardening.md`. The second records
the production profile in the evidence table.

**Goal.** Prove the builder holds its invariants across both steps, and record that
a real tenant has authored and approved a profile.

```text
You are implementing Step 1H of the roadmap in docs/claude-agent-sdk-design.md:
the hardening step for Phase 1. Steps 1a and 1b are merged. Read the roadmap's
"Global rules", "Definition of done", "Operational evidence" and all of Phase 1,
and both steps' implementation notes.

Goal: evidence that the builder cannot be used to widen authority, leak another
tenant's profile, or store dangerous text, and that it has been used for real.

1. Adversarial read of 1a and 1b together. At least:
   - Can a profile name a tool the agent loses later, and what happens at run
     time?
   - Can the Test run start on a DRAFT?
   - Can a SUBMITTED version be edited under its approver?
   - Does any route return another tenant's profile under a guessed id?
   - Does the instructions hash match what the run will send?
   Fix what you find, each with a test.
2. Run the prompt-injection corpus through the instructions path end to end: save
   is refused by rule id for each family, and nothing is stored.
3. Tenant purge: confirm what tenant-purge does to both tables matches their
   data-retention class, with an integration test.
4. Production evidence, read-only. In the proving tenant, with AGENT_PROFILES
   enabled there only, author a profile, submit it, and approve it as a second
   user. Record the profile id, the version, the two user ids (ids only) and the
   audit rows' actions. Then disable the flag again unless the owner says
   otherwise.
5. Update the evidence row, the Current state, and CLAUDE.md's "Claude agent
   engines" section (the profile invariants: author != approver, tools are a
   subset of grants, instructions never grant, pinned by hash).

Deliver per the Definition of done.
```

**Hardening**

- [ ] Each adversarial question has an answer in the implementation note and, where the answer was a defect, a test that fails without the fix.
- [ ] Every family in the injection corpus is refused at save, by rule id, and the table stays empty.
- [ ] Tenant purge behaviour matches `docs/data-retention.md` for both tables (integration test).
- [ ] The Phase 1 evidence row names a production profile id and its approval audit row, or says plainly why none exists.
- [ ] `CLAUDE.md` carries the profile invariants.

**Exit.** The builder is proven not to widen authority or cross tenants, and a real profile has been authored and approved.

---

### Phase 3 — Connect agents customers run

For agents built outside Inflect: in code with the Agent SDK, or in Anthropic's
Console as a Managed Agent. Inflect governs them through `/api/mcp`, and setting
that up takes clicks rather than commands.

#### Step 3a — Connect wizard

**Goal.** From a registered agent's page, mint a key bound to that agent and hand
the customer the exact configuration for their Agent SDK code or their Managed
Agent.

```text
You are implementing Step 3a of the roadmap in docs/claude-agent-sdk-design.md.
Read its "Global rules", "Definition of done" and "Step 3a", the document's
section "Route B: agents the customer runs, set up without a CLI", and the
section "MA-B: connect an agent the customer built in the Console" in
docs/claude-managed-agents-design.md. Read src/app-layer/usecases/api-keys.ts
(createApiKey) and the api-keys admin page. Phase 0 is merged, including 0d.

Goal: a "Connect an agent you run" action on /agents/[agentId] that opens a Sheet
with two tabs, "Agent SDK" and "Managed Agent".

1. Minting reuses createApiKey with agentId preset to this agent. Scopes are
   mcp:read, plus mcp:propose only when the agent holds a propose grant.
   maxAutonomyLevel is preset to the agent's own autonomy level and may only be
   lowered. Minting needs the same permission the api-keys page needs
   (admin.manage) and goes through the same route and rate limit. Do not add a
   second minting path or a weaker gate. If the product wants AI_ADMIN to mint
   here, stop and ask: that is a new permission decision.
2. The key is shown once, with CopyButton, and is never kept in client state after
   the Sheet closes. It is never sent back to the server inside a snippet.
3. The Agent SDK tab generates TypeScript and Python configuration in the
   browser:
   - an mcpServers entry of type 'http' for <origin>/api/mcp with the
     Authorization header;
   - allowedTools set to the exact mcp__inflect__<tool> names the agent is
     granted;
   - the hardening from the design document: tools: [] unless the customer
     needs built-ins, settingSources: [], strictMcpConfig: true, and an explicit
     permissionMode.
   Explain each line in one sentence.
4. The Managed Agent tab lists what to paste into Anthropic's Console:
   - the MCP server entry;
   - a static_bearer vault credential for that URL;
   - the mcp_toolset configuration with an explicit tool list matching the grants;
   - permission_policy always_ask for propose tools.
   No CLI step anywhere.
5. A help-site how-to at docs/user/how-to/connect-an-agent-you-run.md, following
   the help-site rules in CLAUDE.md: route frontmatter, {{ui:<key>}} labels, no
   source paths, permission keys or API routes in the text.
6. Naming per global rule 12.

Tests: rendered tests for both tabs and for a READER (no admin.manage), who sees
an explanation instead of the action; a unit test that the generated allowedTools
equals the agent's grants exactly; an E2E spec on isolatedTenant that mints a
key, copies it, and sees the key in the api-keys list bound to the agent.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The wizard's mint goes through the api-keys route, with `admin.manage` and `API_KEY_CREATE_LIMIT`, proven by a route-level test. No new minting route exists (`api-permission-coverage` unchanged).
- [ ] A key minted by the wizard cannot reach a tool the agent is not granted: an integration test calls `/api/mcp` with it and asserts the refusal and its `AUTHZ_DENIED` row.
- [ ] `maxAutonomyLevel` can only be lowered from the agent's level (test).
- [ ] The key never reaches the server again after minting, and is gone from client state after close (rendered test).
- [ ] The generated snippets never contain "Claude Code", and `allowedTools` contains no wildcard (test).
- [ ] The how-to builds on the help site and passes the docs build's `{{ui:…}}` and route checks.

**Exit.** A customer can connect an Agent SDK agent or a Console-built Managed Agent to Inflect from the agent's page, with a key that reaches only what the agent is granted.

#### Step 3b — Scanner recogniser for the Agent SDK

**Goal.** The harness scanner finds Agent SDK agents in a scanned repository, as it
finds LangChain and LangGraph ones today, and reports their options as harness
evidence.

```text
You are implementing Step 3b of the roadmap in docs/claude-agent-sdk-design.md.
Read its "Global rules", "Definition of done" and "Step 3b", the section "Route B"
(item 3), the "reference scanner" and "harness ingest" passages of CLAUDE.md's
"Agentic AI for IAM roadmap" section, docs/agent-harness-contract.md, and
packages/agent-harness-scanner/src/sources/code/ in full. Phase 0 is merged.

Goal: recognize.ts recognises Agent SDK agents in TypeScript and Python, and the
findings planner turns their options into ladder evidence.

1. In both languages, an agent is a call that resolves through the file's imports
   to the SDK: query from '@anthropic-ai/claude-agent-sdk', and query,
   ClaudeSDKClient or ClaudeAgentOptions from claude_agent_sdk. Never match by
   spelling alone.
2. For each agent, extract what resolves:
   - tools and allowedTools: built-in names as kind 'builtin', mcp__ names
     attributed to their server;
   - mcpServers: an http or sse url as an MCP server, a stdio command as code;
   - model;
   - permissionMode, settingSources, agents (subagents) and hooks presence;
   - credentials by reference only.
   Anything that does not resolve is recorded as unresolved, and the source
   reports UNPARSEABLE. Never guess a value.
3. Map the options onto the existing ladder criteria
   (src/lib/agentic/harness-ladder.ts) in the pure planner
   (src/lib/agentic/harness-findings.ts). The cases to map:
   - permissionMode 'bypassPermissions';
   - settingSources absent or non-empty;
   - a wildcard in allowedTools;
   - Bash or WebFetch in the tool set;
   - no hooks.
   If an option fits no existing criterion, stop and ask rather than invent one.
   The ladder stays report-only.
4. If the report needs a field the current contract (/3) does not carry, stop
   and ask. A new contract id is a new strict schema, never a loosened one.
5. The scanner still reads code and never runs it. The ESLint block and the
   side-effect test must stay green.

Tests: fixtures in both languages for each option and each unresolved shape; a
local function named query is not an agent; the end-to-end ingest of a fixture
report produces a DiscoveredAgent.

Deliver per the Definition of done.
```

**Hardening**

- [ ] A function named `query` not imported from the SDK is not reported, in either language (test).
- [ ] Every unresolved shape marks the source `UNPARSEABLE`, and the agent is still reported with what did resolve.
- [ ] No credential value appears in a report. `firstSecretShapedMember` passes on every fixture report.
- [ ] Each option-derived finding maps to an existing ladder criterion id, asserted by a test that fails on an unknown id.
- [ ] The no-execution ESLint block and side-effect test are green, and the scanner imports nothing outside the allowed `@/` modules.
- [ ] The fake-scanner reference implementation produces an SDK agent, and ingest links or shadows it per the existing rules.

**Exit.** A repository that runs an Agent SDK agent shows that agent in the register's harness view, with its options as evidence.

#### Step 3H — Phase 3 hardening

**Goal.** Prove a connected agent is governed exactly like any other, and that a
real one has connected.

```text
You are implementing Step 3H of the roadmap in docs/claude-agent-sdk-design.md:
the hardening step for Phase 3. Steps 3a and 3b are merged. Read the roadmap's
"Global rules", "Definition of done", "Operational evidence" and all of Phase 3.

Goal: evidence that a customer-run agent connected through the wizard is bounded
by the register, and that one has run.

1. Adversarial read of 3a and 3b together. At least:
   - Can a wizard key outlive the agent's retirement? (The retirement cascade
     must revoke it.)
   - Does a key survive an ownership transfer correctly?
   - Can a snippet be made to carry another agent's tools?
   - Does the scanner link the agent it finds to the key the wizard minted, and
     on what evidence?
   Fix what you find, each with a test.
2. A proving run, made with a script under scripts/:
   - a minimal Agent SDK program (TypeScript) with the wizard's generated
     options, connected to the staging or production proving tenant through a
     wizard-minted key;
   - it calls one granted read tool and one ungranted tool.
   Record the audit rows for both, by action and id. Run the scanner over that
   script and record the DiscoveredAgent id.
3. If an Anthropic account is available to the owner, connect a Console-built
   Managed Agent the same way and record its audit rows. If not, say so in the
   evidence table, and do not substitute a test.
4. Update the evidence row, the Current state of both design documents, and
   CLAUDE.md.

Deliver per the Definition of done.
```

**Hardening**

- [ ] Retiring the agent revokes every wizard-minted key in the same cascade (integration test), and a call with one afterwards is 401.
- [ ] The proving run's ungranted call produced an `AUTHZ_DENIED` row, and its granted call a `TOOL_CALL` audit row, recorded by id.
- [ ] The scanner found the proving script's agent, and the evidence row names the `DiscoveredAgent` id.
- [ ] The Managed Agent proving run is recorded, or its absence is stated with the reason.

**Exit.** A customer-run agent has connected for real, and is proven to be bounded by its grants and stopped by its retirement.

---

### Phase 4 — Agent SDK engine (conditional)

Starts only when a real profile needs something the Tool Runner engine cannot give
it (decision 1), such as hook-based deferral of a call to a person. Until then
this phase is a design on paper, and that is the intended state.

#### Step 4a — Spike

**Goal.** Measure what the SDK costs in this deployment and prove the lockdown
works, before any product code depends on it.

```text
You are implementing Step 4a of the roadmap in docs/claude-agent-sdk-design.md.
Read its "Global rules", "Definition of done" and "Step 4a", and the document's
sections "What the Claude Agent SDK is", "The locked options builder" and
"Operational cost, stated before anyone builds it". Phase 2 is merged. Before
starting, confirm that "Decisions for the owner" records a profile that needs
this engine. If none is recorded, stop and report that this phase has no
trigger.

Goal: an implementation note with measurements, and a throwaway harness that
never merges to the product path.

1. Re-read the live Agent SDK documentation pages the design cites. List every
   difference from the design in the note.
2. In scripts/spikes/ (or a branch that is not merged), run one fixed profile
   through lockedOptions with a faux tool set and a real model call in a
   container shaped like the worker. Measure:
   - peak RSS, for a ten-turn run with twenty tools;
   - time to first token, with and without startup();
   - the image-size cost of the SDK's native binary.
3. Prove by test that the system/init message reports exactly the resolved tools
   plus Skill, and nothing from the host (settings, CLAUDE.md, MCP connectors,
   auto memory).
4. Prove which skill-loading path works under settingSources: [], or that none
   does, in which case the design's activate_skill fallback is the answer.
5. Write the note: the measurements, the differences, and a recommendation on
   decision 1 with the concurrency cap the measurements imply.

Deliver per the Definition of done, except that nothing here merges into src/.
```

**Hardening**

- [ ] The measurements are from a real run, each with its date and the SDK version.
- [ ] `system/init` is asserted to equal the resolved set exactly, in a test that fails if one host setting leaks in.
- [ ] The note lists every difference between the live documentation and the design.
- [ ] Nothing under `src/` imports the SDK.

**Exit.** The owner has the numbers to decide whether a second engine is worth its cost.

#### Step 4b — Agent SDK driver, reader-only

**Goal.** Build the driver behind `DRIVER_IMPLEMENTED = false`, and ship the
`CLAUDE_SDK` enum value with no writer.

```text
You are implementing Step 4b of the roadmap in docs/claude-agent-sdk-design.md.
Read its "Global rules", "Definition of done" and "Step 4b", the sections "How it
would sit in Inflect (Route A)" through "What changes in Inflect's code", and the
4a implementation note. The owner has decided to adopt this engine. If that
decision is not recorded under "Decisions for the owner", stop.

Goal: a complete claude-agent-sdk driver that the gate can never select yet.

1. Add 'claude-agent-sdk' to AGENT_DRIVERS, classify it in isReasoningEngine, add
   AGENT_DRIVER_CLAUDE_SDK (opt-in, read like AGENT_DRIVER_FLUE), and set
   DRIVER_IMPLEMENTED for it to false. Add CLAUDE_SDK to AgentDriverMode as a
   reader-only value: coerceStoredDriverMode understands it, and no writer can set
   it yet.
2. src/lib/agentic/claude-sdk/ mirrors flue/:
   - driver.ts plans or refuses, with no SDK import;
   - execute.ts is reached by dynamic import only;
   - options.ts is lockedOptions, exactly as the design's table;
   - tools.ts builds the in-process MCP server over the engine-neutral core;
   - hooks.ts holds the catch-all PreToolUse hook for kill, budget and deny;
   - ledger.ts writes the per-assistant-message MODEL_CALL and Art 12 rows.
3. A guard pins the options: nothing in src/ calls query() except execute.ts, and
   lockedOptions sets every value in the design's table. Prove it by planting a
   violation.
4. Size the engine's concurrency cap from 4a's measurements, through
   run-concurrency-policy.ts.
5. Pass the driver conformance suite (Step 0b) with a faux client.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The conformance suite passes for this driver, and every scenario is mutation-proved against it.
- [ ] `lockedOptions` is pinned value by value: removing `settingSources: []`, `strictMcpConfig` or the catch-all hook each fails the guard.
- [ ] `env` is a built map. A test proves the worker's `DATABASE_URL` and `DATA_ENCRYPTION_KEY` never reach the child process.
- [ ] The per-run config directory and working directory are removed in `finally`, including on abort (test).
- [ ] With `DRIVER_IMPLEMENTED` false, no input selects this engine (`agent-driver-gate` grid extended).
- [ ] A stored `CLAUDE_SDK` reads as the mode, and no writer accepts it yet (test).
- [ ] The rollback plan and risk assessment are in the pull request.

**Exit.** The driver exists, is conformance-proven, and cannot run.

#### Step 4c — Turn the Agent SDK engine on

**Goal.** One deploy after 4b, let a tenant choose the engine.

```text
You are implementing Step 4c of the roadmap in docs/claude-agent-sdk-design.md.
Read its "Global rules", "Definition of done" and "Step 4c". Step 4b is merged
and deployed to production (confirm the deployed image carries the CLAUDE_SDK
enum before writing it anywhere).

Goal: DRIVER_IMPLEMENTED for 'claude-agent-sdk' is true; the settings page (0c)
offers it; the builder's Test run works on it.

1. Flip the flag in the diff that makes it true, and nothing else in that line's
   commit.
2. setAgentDriverSetting and the PUT schema accept CLAUDE_SDK; the settings page
   offers it with a sentence on what it is.
3. docs/sub-processors.md: the Anthropic row names this engine for agent runs,
   with the data category "tenant-authored agent instructions".

Tests: an E2E spec on isolatedTenant that selects the engine and runs an approved
profile's Test run to completion against the faux client in E2E mode; the gate
grid's affirmative case for this engine.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The flag flip is its own commit, revertible by itself.
- [ ] The deployed image was confirmed to carry the enum before this merged (the pull request says how).
- [ ] The sub-processor row is updated in the same diff.
- [ ] The E2E run completes and its ledger shows a `MODEL_CALL` and a `TOOL_CALL` step.

**Exit.** A tenant can choose the Agent SDK engine and run a profile on it.

#### Step 4H — Phase 4 hardening

**Goal.** Prove the engine in production and under stop conditions.

```text
You are implementing Step 4H of the roadmap in docs/claude-agent-sdk-design.md:
the hardening step for Phase 4. Steps 4a–4c are merged. Read the roadmap's
"Global rules", "Definition of done", "Operational evidence" and all of Phase 4.

Goal: evidence that the engine behaves in production as the conformance suite
says it does.

1. Adversarial read of 4b and 4c together, for anything the subprocess boundary
   adds:
   - environment leakage;
   - a process left running after abort or SIGTERM;
   - a temp directory left behind;
   - a hook that times out open.
   Fix what you find, each with a test.
2. In the proving tenant, run a profile on this engine. Then:
   - run it again with the kill switch engaged mid-run (the drill agent);
   - run it again under SIGTERM of the worker.
   Record the run ids, the halt reasons, peak RSS from the container metrics,
   and that no child process or temp directory survived (read-only inspection
   per CLAUDE.md's Production VM section).
3. Update the evidence row, the Current state, and CLAUDE.md.

Deliver per the Definition of done.
```

**Hardening**

- [ ] The kill-switch drill halted the production run before its next model call, recorded by run id and halt reason.
- [ ] After SIGTERM, no `claude` child process and no per-run directory remained (recorded with the inspection command's output, secrets omitted).
- [ ] Production peak RSS is within the cap 4b set, or the cap is corrected in this pull request.
- [ ] The evidence row is filled from production, not from a test.

**Exit.** The Agent SDK engine has run in production, stopped when told to, and left nothing behind.
