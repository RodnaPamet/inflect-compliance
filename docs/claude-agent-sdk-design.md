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
| **A. Inflect-hosted** | Inflect's worker runs the SDK as a third run driver beside `static` and `flue` | Fills in an **agent builder** in `/agents`: instructions, tools from the agent's existing grants, skills, model tier, trigger. Never sees the SDK. | **Recommended**, behind a spike (Roadmap step 0) |
| **B. Customer-hosted** | The customer runs their own Agent SDK code | Clicks **Connect an agent you run** on a registered agent; Inflect mints a bound key and generates the SDK configuration to paste in. The harness scanner learns to recognise Agent SDK code. | **Recommended as a complement.** Cheap, and mostly a UI over controls that exist |
| **C. Anthropic-hosted** | Claude Managed Agents, in the customer's own Anthropic organisation | Inflect provisions the agent through Anthropic's API from the same builder | **Deferred.** New processing at Anthropic, and the customer's Anthropic account becomes part of Inflect's control surface |

Route A is the one that delivers "set up my own agent without a CLI", because
the tenant never touches code at all. It works only if every control the
register already enforces stays **in front of** the SDK, the way they stay in
front of Flue today. The rest of this document is mostly about how to make that
true. The design rule is the one `src/lib/agentic/flue/tools-adapter.ts` already
states for Flue: *the external engine decides what to try; the funnel decides
what is permitted.*

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

<!-- SDK-SECTION -->
