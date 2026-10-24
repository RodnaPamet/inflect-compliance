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
| **A. Inflect-hosted** | Inflect's worker runs the SDK as a run driver beside `static` and `flue` | Fills in an **agent builder** in `/agents`: instructions, tools from the agent's existing grants, skills, model tier, trigger. Never sees the SDK. | **The builder is recommended. This SDK as its engine is not yet.** Step 0 compares it with the Tool Runner on the same profile |
| **B. Customer-hosted** | The customer runs their own Agent SDK code | Clicks **Connect an agent you run** on a registered agent; Inflect mints a bound key and generates the SDK configuration to paste in. The harness scanner learns to recognise Agent SDK code. | **Recommended.** This is where the SDK fits Inflect best: cheap, and mostly a UI over controls that exist |
| **C. Anthropic-hosted** | Claude Managed Agents, in Inflect's or the customer's Anthropic organisation | Inflect provisions the agent through Anthropic's API from the same builder | **Deferred.** See `docs/claude-managed-agents-design.md` |

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
- **Connect an agent it runs elsewhere** by minting an API key bound to the
  agent (`TenantApiKey.agentId`, `maxAutonomyLevel`) and pointing the agent at
  `/api/mcp`.

What a tenant **cannot** do is say what the agent should *do*. An Inflect-hosted
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
`WORKFLOW_RUN_STARTED` audit row.

### How Flue was made safe, which is the template

Flue (`@flue/runtime`, an in-process ESM library) is the precedent for running
an engine we did not write. Every control below is something an Agent SDK
driver would have to reproduce:

| Control | Where it lives for Flue |
| --- | --- |
| Tools reach the funnel and nothing else | `flueToolsFor` → `runGuardedTool` → `runReadTool` / `runProposeTool` (`flue/tools-adapter.ts`) |
| AI Guard on the model's arguments (egress) and on tool results (untrusted input) | `runGuardedTool`, steps 1 and 3 |
| The advertised tool set is the grant ∩ card ∩ scope ∩ autonomy ceiling | `offerTools` |
| Sandboxes, bash, file write/edit and channels are refused | `flue/refused-capabilities.ts` + `tests/guards/flue-refused-capabilities.test.ts` |
| Runtime-supplied tools are reported, not hidden | `flue/runtime-tools.ts` (`task`, `activate_skill`) |
| Kill switch asked per turn, not only at start | `flue/execute.ts` |
| Run caps (wall clock, tool calls, tokens) charged per tool call | `createRunBudget` in `execute.ts` |
| Every model call and tool call is a hash-chained `WorkflowStep` | `MODEL_CALL` / `TOOL_CALL` through `recordStep` |
| EU AI Act Art 12 decision row per model call | `flue/model-decision.ts` → `logAiDecision` |
| Residency: a `LOCAL_ONLY` tenant never reaches an external model | `flue/model-selection.ts`, which picks a model specifier per run, and never `setProvider` per run (module singleton, cross-tenant race) |
| Delegation is capped and narrows | `flue/delegation-gate.ts` (fan-out), `flue/subagents/` (subset of the parent's tools, depth 1) |
| Skills mount only through the gate, and the run pins their hashes | `flue/skills/mount-gate.ts`, `WorkflowRun.mountedSkills` |
| A reasoning run must be vouched for by the register | `startWorkflowRun`: `chosenDriver === 'flue'` requires `standing === 'vouched'` |
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

### What the harness scanner recognises

The reference scanner's `code` source
(`packages/agent-harness-scanner/src/sources/code/recognize.ts`) reads static
code for LangChain and LangGraph agents only. An agent built on the Claude Agent
SDK that a customer runs today is invisible to it, and so it is reported as
neither shadow nor registered.

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
neutrality is deliberate, because Route A's engine choice is the open
question in step 0.

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
| Advertised set = grant ∩ card ∩ scope ∩ ceiling | `offerTools` output becomes the SDK server's tool list. Tool search should be off for it (`alwaysLoad: true`), so the model sees the whole bounded set |
| Kill switch every turn | the `PreToolUse` hook calls `resolveKillState` and denies. The stream loop also checks on every `assistant` message and aborts |
| Run caps | charged in the `PreToolUse` hook through `createRunBudget`. `maxTurns` / `maxBudgetUsd` sit behind it |
| `MODEL_CALL` step + Art 12 decision row | one per `assistant` message from the stream. `result.modelUsage` reconciles the totals at the end |
| Guard on model free text | **new, and better than Flue.** The assistant text is visible in the stream, so it can be egress-scanned before it becomes the run's answer. Flue's hook could not see it |
| `TOOL_CALL` step | written inside the tool handler wrapper, as Flue's `wrapForLedger` does |
| Delegation | off in v1 (`Agent` disallowed). If adopted later: `agents` definitions whose `tools` are a subset of the parent's resolved set, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`, and fan-out counted in `SubagentStart`. Hooks fire inside subagents, so the same deny applies |
| Skills through the mount gate | resolved and hashed as today, then materialised as `SKILL.md` files from the pinned, decrypted, hash-checked text, and deleted in `finally`. **Where they are written is open.** Under `settingSources: []` the per-run `.claude/skills` is *not* discovered, because that path loads through the `project` source. A local plugin directory (`plugins: [{ type: 'local', path }]`) is the candidate, but the plugins page was not verified. Step 0 proves which path loads with nothing else enabled. The fallback is Inflect's own `activate_skill` tool in the `inflect` server, which keeps disclosure progressive and needs no files |
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
- `startWorkflowRun` tests `chosenDriver === 'flue'` for the registration gate and
  for skill pinning. Both become `isReasoningEngine(chosenDriver)`. A third
  engine left out of either check would start unvouched, with no allowlist.
- `flue/tools-adapter.ts` splits into an engine-neutral core (`offerTools`,
  `runGuardedTool`, `ReviewLatch`, the guard observers) and two thin shims. The
  core is reused as is. Only the shape conversion is per engine (valibot for
  Flue, a Zod raw shape for the SDK; each MCP tool already carries
  `argsSchema: ZodType`).
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
in step 0 measures three things: peak RSS for a ten-turn run with twenty tools,
time to first token with and without `startup()`, and the binary's image-size
cost.

## Route B: agents the customer runs, set up without a CLI

Some customers will build on the Agent SDK themselves, because their agent
needs the customer's own files, shell or network. Inflect cannot host that, and
should not. It can make governing it a few clicks:

1. **Connect an agent you run**, on the agent's detail page. Inflect mints an
   API key bound to the agent (the existing `TenantApiKey.agentId` and
   `maxAutonomyLevel`), scoped `mcp:read` (plus `mcp:propose` when the agent
   holds a propose grant), and shows it once.
2. It generates the **SDK configuration** for that agent, in TypeScript and
   Python: `mcpServers.inflect = { type: 'http', url: '<origin>/api/mcp',
   headers: { Authorization: 'Bearer <key>' } }`, `allowedTools` set to the
   agent's exact granted tool names, and the hardening above (`settingSources:
   []`, `strictMcpConfig`, an explicit `permissionMode`). Copy, paste, run.
   The customer types no `curl` and no `ant`.
3. The harness scanner's `code` source learns to recognise the SDK
   (`@anthropic-ai/claude-agent-sdk`, Python `claude_agent_sdk`): `query(...)` /
   `ClaudeSDKClient(...)` call sites, their `tools`, `allowedTools`,
   `mcpServers`, `permissionMode`, `settingSources` and `agents`. An SDK agent in a
   scanned repository then shows up as shadow or registered like a LangGraph
   one. Its options also become harness-ladder evidence. `bypassPermissions`, a
   missing `settingSources: []` or a wildcard `allowedTools` are findings
   against H2/H3. They are never gates, because the ladder is report-only.

Every call still lands on `/api/mcp`, so the funnel's authorization applies
unchanged: kill switch, grants, policy card, autonomy ceiling, audit,
propose-not-commit. Route B adds no authority, no sub-processor and no engine.

One control does **not** come with it. The AI Guard slices that sit around
Flue's tool calls (`runGuardedTool`: egress on arguments, untrusted-input on
results) are not on the direct MCP route. `src/app/api/mcp/route.ts` and
`src/lib/mcp/` call neither `guardEgress` nor `guardUntrustedInput`. A proposal
is still guarded, because `createAgentProposal` scans each item at the queue.
A read is not. For a customer-hosted agent the injection risk in a read's
*result* lands in the customer's own model, which Inflect does not run. The
argument scan is a different matter: it is Inflect's own egress control, and
it applies only to engines Inflect runs. Whether to add it to `/api/mcp` is a
decision of its own (decision 6 below), and it is worth making before Route B
invites more external agents in.

## Route C: Managed Agents

Covered in `docs/claude-managed-agents-design.md`. The short reason it is not
the first route: Anthropic stores the agent configuration and the session
history, and the Managed Agents overview says it "is not currently eligible for
Zero Data Retention or HIPAA Business Associate Agreement (BAA) coverage".

## Decisions for the owner

1. **Which engine runs the builder's agents first.** Recommended: the Tool
   Runner (`docs/claude-tool-runner-design.md`, decision 1). The Agent SDK
   brings hooks, a permission engine, subagent definitions and compaction. It
   costs a subprocess and a lockdown whose every line exists to turn a default
   off. The Tool Runner brings an in-process loop with nothing to turn off. This
   driver stays the candidate second engine, adopted only if a profile needs
   something the Tool Runner engine cannot give it, such as hook-based deferral
   of a call to a human.
2. **The four #3351 questions, for instructions instead of compose text.**
   *Recorded where:* encrypted on `AgentProfileVersion`, its hash pinned on every
   run, and rendered as text, never markup. *Through the AI Guard:* scanned at
   save; at run time it is the operator's own fenced block, never mixed into
   tool output. *Which model:* the existing Anthropic sub-processor; naming the
   new data category on the row is proposed as sufficient, matching the
   2026-10-18 decision for Flue. *Unresolvable:* a profile asking for a tool
   the agent is not granted is refused at save, never silently dropped at run.
3. **Who approves a profile version.** Proposed: `admin.agent_registry`, with
   author ≠ approver, as for tenant skills. A new key would be cleaner, at the
   price of a custom-role migration.
4. **Delegation in v1.** Proposed off. Turning it on later is a reviewed diff
   that adds `Agent` back with a subset-only definition.
5. **Branding.** The builder says "Agent", and names Claude as "Powered by
   Claude" where the model is shown. It never says "Claude Code".
6. **The AI Guard on the direct MCP route.** Today `/api/mcp` authorizes but
   does not guard a read's arguments or result. Proposed: add the egress slice on
   arguments to the route, sharing `runGuardedTool`'s step 1. Leave the result
   scan to the engine that consumes the result, because only Inflect's own
   engines put a result into Inflect's model.

## Roadmap (future direction)

Each step is one pull request. Steps 1–3 are shared with the Tool Runner design;
the roadmap artifact orders the three designs together.

0. **Spike, no merge to the product path.** Run one fixed profile through
   `lockedOptions` against a faux tool set. Measure peak RSS, time to first token
   and image size. Prove by test that `system/init` reports exactly the resolved
   tools plus `Skill`. Record the result in an implementation note. It confirms
   or overturns decision 1; it does not block the Tool Runner engine.
1. **Engine-neutral tool core.** Split `tools-adapter.ts`. Generalise the two
   `=== 'flue'` checks in `startWorkflowRun`. Add a driver conformance suite that
   every engine must pass: kill switch per turn, caps, one step per model and
   tool call, guard on both slices, residency refusal, no unresolved tool
   reachable. Flue is its first subject.
2. **Agent profile model and usecases.** `AgentProfile` / `AgentProfileVersion`,
   create, version, approve, retire; the encryption manifest entry; the
   retention-doc classification; RLS; the two-tenant test; tenant-scoped
   definition lookup in `startWorkflowRun`.
3. **Builder UI.** A Behaviour tab on `/agents/[agentId]`: instructions editor,
   tool and skill pickers bounded by grants, model tier, output kind, trigger,
   approve/reject for a second person, and a version history. Plus a **Test run**
   that starts a read-only run and opens it in the runs tab.
4. **Engine settings page.** `/admin/ai-features` gains the tenant's engine
   choice. Today it is `PUT /api/t/{slug}/admin/agent-driver` with no UI.
5. **This driver, as the second engine**, when a profile needs it: two-deploy
   enum, env switch, `claude-sdk/`, the options guard, conformance suite green.
6. **Route B, connect wizard.** Key minting with the bound agent preselected, and
   the generated TypeScript/Python configuration.
7. **Route B, scanner recogniser.** `recognize.ts` learns the SDK in both
   languages; the ladder learns the option findings.
