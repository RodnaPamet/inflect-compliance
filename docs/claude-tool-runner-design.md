inflect · claude tool runner · design v1 · 2026-10-24

# The Claude Tool Runner in Inflect: the in-process engine for customer-built agents

> **Status: living design** — research into the Tool Runner in Anthropic's
> TypeScript SDK, and a recommendation for where it belongs in Inflect's agent
> stack. None of it is built. The **Current state** section is true today. The
> **Roadmap** section is the plan, one pull request per step. Companion
> documents: `docs/claude-agent-sdk-design.md`, which introduces the agent
> builder this engine would run, and `docs/claude-managed-agents-design.md`.
> SDK facts were read on 2026-10-24 from the bundled Claude API reference, the
> live Tool Runner page on platform.claude.com, and the
> `anthropics/anthropic-sdk-typescript` source at v1.3.0. If the code
> contradicts a fact here, the code wins and the pull request that finds it
> corrects this document.

## The answer, briefly

The Tool Runner is a helper in the ordinary Anthropic SDK
(`client.beta.messages.toolRunner`). It loops "call the model, run the tools it
asked for, call again" over tools **you** hand it. It has no built-in tools, no
filesystem, no subprocess and no sandbox. It is a harness and nothing more:
Inflect would host it in the worker, the same way it hosts Flue.

| Question | Answer |
| --- | --- |
| Should it run the agents customers build in the product? | **Yes. It is the recommended first engine** for the agent builder described in `docs/claude-agent-sdk-design.md` (Route A). In-process, nothing to turn off, every call through the funnel, one client per run so residency cannot race |
| Should it replace the assistant's tool loop? | **No.** `src/app-layer/ai/assistant/tool-loop.ts` is provider-neutral on purpose (#3808: "extend this pattern rather than adopt an SDK"). The runner speaks only Anthropic's API |
| Can it serve a `LOCAL_ONLY` tenant? | **No.** The local gateway speaks the OpenAI chat-completions API. Such a run is refused with a named reason, never sent externally; Flue stays the engine there |
| Does it need a new sub-processor? | **No**, provided server-side conversation storage ("message threads") is switched off on every call. It is on by default since SDK 1.2.0 |

## Current state (true today)

- **The SDK is a direct dependency, and one function builds every client
  (Step 2a, #4148).** `@anthropic-ai/sdk` 1.x is in `dependencies`, exact-pinned
  (read the version off `package.json`) and reviewed in
  `docs/dependency-risk-review.md`. pi-ai keeps its own nested
  `0.129.0` for Flue. `clientForRun` in `src/lib/agentic/tool-runner/client.ts`
  is the only place a client is built, and `local/anthropic-client-single-seam`
  refuses a load of any `@anthropic-ai/*` package elsewhere under `src/`. It
  refuses a `LOCAL_ONLY` run first (`TOOL_RUNNER_LOCAL_ONLY_UNSERVED`), then a
  missing key (`EXTERNAL_CREDENTIAL_NOT_CONFIGURED`), then a set
  `ANTHROPIC_CUSTOM_HEADERS` (`SDK_AMBIENT_HEADERS_SET`). It pins the host, the
  log level, tracing at `metadata_only` and no webhook key. Each client it
  builds refuses, before `fetch`, any request that is not a Messages call or
  that asks for a server-held thread, a container, the MCP connector or a server
  tool. `toolRunnerModelFor` maps a profile tier to a model id
  (`AGENT_TOOL_RUNNER_MODEL_BALANCED` / `_DEEP`, default Sonnet 5.5 and Opus
  5.5). The Tool Runner driver is its one caller.
  Every request is logged as `tool-runner: request` by shape only: method,
  path, top-level body keys and whether a `thread` member was present. The
  same shape is recorded as `wire` on the run's `MODEL_CALL` step input, so
  the run page shows what was sent without a log read.
- **The Tool Runner engine runs agent profiles (Step 2b, #4149, turned on in
  Step 2c, #4150).** `src/lib/agentic/tool-runner/` holds `driver.ts` (a pure
  plan that refuses with a named reason, then the hand-off), `execute.ts` (the
  loop), `tools.ts` (one runnable tool per offered tool, over the engine-neutral
  core), `params.ts` (`lockedParams`) and `model-decision.ts` (the Art 12 row).
  It passes the driver conformance suite against a faux model behind `fetch`,
  and every scenario was mutation-proved. `DRIVER_IMPLEMENTED['tool-runner']` is
  true and `TOOL_RUNNER` is a WRITTEN value of `AgentDriverMode`, so a tenant
  can choose it on Admin → AI features → Agent engines, where it is described
  "Powered by Claude". It runs only where it is available: the operator sets
  `AGENT_DRIVER_TOOL_RUNNER=1`, or leaves it unset and the workspace's
  organization turns the engine on in its Settings (#4557). Any other set value
  makes it unavailable everywhere. `runsProfiles` is true for it alone, a profile's
  definition asks for it, and the Anthropic row of `docs/sub-processors.md`
  names "tenant-authored agent instructions". The builder's **Test run**
  (Behaviour tab, `POST …/profile/versions/:version/test-run`) starts a
  read-only run of the approved version in force or the submitted one, as the
  agent, under the Test-run key `agent-profile:<id>@v<n>:test-run`; the worker
  rebuilds the definition from the version the run pinned
  (`resolvePinnedRunDefinition`). The deployed image was confirmed to read
  `TOOL_RUNNER` before any writer accepted it (a8ba6717, recorded on #4150).
  `tests/integration/agent-profile-test-run.test.ts` drives a Test run to
  COMPLETED on a real database with a fake model; the browser E2E stops at the
  run starting, because the E2E harness has no worker and no model (owner
  decision, 2026-10-29).
  Four things it does that differ from the table above:
  - **Arguments are validated by the funnel.** The funnel checks each tool's
    `argsSchema` after its gate (`runReadTool` step 2). Validating in the tool's
    `run` would put validation ahead of the gate, so `run` checks only the shape.
  - **A stop between calls aborts the next request.** A cap, a guard verdict, or
    a kill read when a tool call finishes aborts the run's signal, so the
    request the runner would send next never leaves. The loop body also checks
    the kill switch after every message, before the turn's tools run.
  - **An empty catalogue sends nothing.** Flue makes one model call and then
    settles `EMPTY_CATALOGUE`. This engine settles first.
  - **No streaming in v1.** `max_tokens` per tier (16,000 and 20,000) stays
    under the SDK's non-streaming ceiling, so `stream` is pinned false and each
    yield is one whole message.
- **Skills reach the model through `activate_skill` (Step 2d, #4151).** A run's
  skills are resolved by the one resolver every reasoning engine uses
  (`resolveRunSkillMount` → `resolveRunSkills`, through the mount gate), at
  admission, where they are pinned on the row, and again at each segment, where
  they must match the pins (`skill_pin_drift`). A profile's run mounts the
  skills its version names. A tenant skill is read BY NAME in the run's own
  tenant, and a name with no approved version refuses the run. A version whose
  skills are over the catalogue budget, or name a shipped skill that cannot
  mount, is refused when saved and when approved (#4589, #4599), so at a run
  those refusals catch only what changed since: a tenant skill approved again
  with a longer description, or a deploy that changed a shipped one. A refusal
  settles the run `skill_not_mountable: …` before any model call, on this
  engine and on
  Flue alike; the conformance scenario `refused-skill-never-reaches-the-model`
  holds both. The catalogue, one `name: description` line per skill (exactly
  what the 2 KiB per-run budget measures), sits in the system prompt after the
  preamble and before the operator's instructions. `activate_skill`
  (`tool-runner/skills.ts`) is Inflect's own tool, offered only beside a
  catalogue and after the empty-catalogue check. It returns a mounted skill's
  instructions, fenced with its pin, after re-hashing them against the row's
  pin (`SKILL_PIN_MISMATCH` otherwise), and answers any other name
  `SKILL_NOT_MOUNTED` without echoing it. Each activation is a TOOL_CALL step,
  charged to the step cap, and never a funnel call. It is reported to the
  register as engine-supplied (`tool-runner/supplied-tools.ts`), beside Flue's
  runtime tools on the agent's Tools tab.
- **The engine has run in production (Step 2H, 2026-11-11).** A profile's Test
  run completed in the proving tenant, a second was stopped by the kill switch
  and settled Aborted, and a `LOCAL_ONLY` tenant's run was refused
  `tool_runner_local_only_unserved` before any step. Every recorded request was
  `POST /v1/messages` with no `thread` member. Run ids and counts are in the
  Operational evidence table of `docs/claude-agent-sdk-design.md`.
- **SDK 1.x speaks API version `2026-10-21`.** It sends that version and the key
  as `Authorization: Bearer`. Inflect's other Anthropic callers use raw `fetch`
  on `2023-06-01` (`src/app-layer/ai/*/anthropic-provider.ts`,
  `assistant/turn-provider.ts`), and are untouched.
- **The assistant owns a hand-written loop.** `tool-loop.ts` with
  `turn-provider.ts` runs the same loop against anthropic, openrouter, local and
  stub providers. It dispatches tool calls one at a time and checks the guard
  latch after each, bounds iterations, total tool calls and wall clock, and
  states its halts in the answer. Its message builder drops `thinking` blocks
  between turns.
- **The run engines are `static`, `flue` and `tool-runner`**, behind the driver seam described
  in `docs/claude-agent-sdk-design.md` → *The driver seam*. That document's
  *How Flue was made safe* table is the list of controls any new engine must
  reproduce.
- **The local model route is OpenAI-compatible.** `flue/providers.ts` registers
  `inflect-local` with `openAICompletionsApi` against `AI_LOCAL_BASE_URL`.

## What the Tool Runner is, as documented on 2026-10-24

```ts
const runner = client.beta.messages.toolRunner(
  { model, max_tokens, system, messages, tools, max_iterations, thread: false, /* any Messages param */ },
  { signal, headers },
);
for await (const message of runner) { /* yielded before this turn's tools run */ }
const final = await runner.done();
```

- **Tools.** `betaZodTool` (Zod; `zod/v4` supported, validated before `run`),
  `betaTool` (raw JSON Schema; **no validation**, `parse` is the identity), and
  `betaStandardSchemaTool` (accepts Valibot). A tool's
  `run(args, { toolUse, signal })` returns a string or content blocks. A throw
  becomes `is_error: true`; `ToolError` controls the error's content.
- **Per-turn control.** In the loop body: `runner.params` (the request just
  sent), `setMessagesParams`, `pushMessages`, `generateToolResponse()` (run the
  tools now and mutate the results, for example to add `cache_control`),
  `compactBeforeNextTurn()`, `addTools`/`removeTools` (beta
  `inline-tools-2026-09-15`).
- **Stopping.** `max_iterations` counts API requests. `refusal`, `max_tokens`
  and `model_context_window_exceeded` end the loop without running that turn's
  tools. `pause_turn` and compaction stops are resumed automatically (since
  0.121.0). An `AbortSignal` reaches the API call and each tool's `signal`, but
  the runner waits for a running tool to return.
- **Concurrency.** Tool calls in one turn run **concurrently**
  (`Promise.all`).
- **Message threads.** Since 1.2.0 the runner keeps the conversation on
  Anthropic's servers by default (beta `message-threads-2026-08-12`) for
  `Anthropic`, `AnthropicAws` and `AnthropicFoundry` clients. `thread: false`
  turns it off. Retention terms for threads were not found; the page returned
  404.
- **Visibility.** Each yielded message carries `usage` (with
  `usage.iterations` for fallback and compaction), `model`, `stop_reason`,
  the assistant's text and its `thinking` blocks. On Opus 5.5 thinking text is
  empty by default; `thinking: { type: 'adaptive', display: 'summarized' }`
  (or `'updates'`, beta) makes it readable.
- **Platforms.** The runner exists on every client: `Anthropic` (optionally
  with `baseURL`), `AnthropicAws`, `AnthropicBedrockMantle`, `AnthropicVertex`,
  `AnthropicFoundry`. The runner holds only the client it was built from.
- **What it does not have.** No subagents, no skills mechanism, no permission
  engine, no hooks beyond the loop body. Server tools (`web_search`,
  `web_fetch`, `code_execution`) exist only if listed in `tools`.
- **A documentation disagreement.** The live page says "when you need
  human-in-the-loop approval… use the manual loop instead". The SDK source and
  the bundled reference show the loop body can take over a turn. For Inflect it
  does not matter: approval is inside `run`, because `run` is the funnel.

## How it would sit in Inflect

The engine is a run driver, `tool-runner`, beside `static` and `flue`. It
executes the same agent-profile runs the Agent SDK design describes. The
builder, the profile model and admission are shared, and only the box labelled
"engine" differs.

```
  startWorkflowRun(ctx, 'agent-profile:<id>@v<n>')   ← unchanged admission
        ▼
  selectRunDriver → 'tool-runner'
        ▼
  src/lib/agentic/tool-runner/execute.ts
        client = clientForRun(residency)            ← one client per run, never shared
        runner = client.beta.messages.toolRunner(lockedParams(run), { signal })
        for await (msg of runner):                  ← one iteration = one model call
            kill switch? → abort + settle
            MODEL_CALL step + Art 12 row (digest of runner.params)
            egress guard on msg's text
            stop_reason refusal / max_tokens → settle with a named reason
        tool.run(args) ─────────────► validate argsSchema → runGuardedTool → funnel
```

### The locked parameters

One function, `lockedParams(run)`, builds every runner request. Nothing else
in `src/` constructs a runner. A guard pins that, and pins the values below.

| Parameter | Value | Why |
| --- | --- | --- |
| `thread` | `false` | keeps the conversation off Anthropic's servers; threads are new stored processing the sub-processor row does not describe |
| `tools` | one `betaTool` per resolved tool, plus `activate_skill` when skills are mounted | the resolved, narrowed set; no server tools |
| `tool_choice` | `{ type: 'auto', disable_parallel_tool_use: true }` | serial dispatch keeps the hash-chained `TOOL_CALL` order, cap charging and the guard latch exact. Forced `any`/`tool` is a 400 on Opus 5.5 and Sonnet 5.5 anyway |
| `system` | Inflect's fixed preamble + the pinned profile instructions, fenced and labelled, with a `cache_control` breakpoint | stable prefix for caching |
| `model`, `output_config.effort` | from the profile's tier, through the residency resolver | Opus 5.5 defaults to `medium` effort; set it explicitly |
| `thinking` | `{ type: 'adaptive', display: 'summarized' }` | the Art 12 output summary and the egress scan need readable text |
| `max_iterations` | from `resolveRunCaps` | the iteration bound |
| `max_tokens` | per tier, streaming above the SDK's non-streaming ceiling | |
| `fallbacks` | `'default'` (beta `server-side-fallback-2026-07-01`) on the first-party client | a refusal reroutes inside the call; each step records `msg.model` |
| request `signal` | the run's wall clock, the kill switch and SIGTERM drain | |

Two things are deliberately **not** used in v1. The MCP connector
(`mcp_servers` + `mcp_toolset`) would have Anthropic call `/api/mcp` itself,
so the worker could not run the egress guard, charge caps or check the kill
switch before the call; it is also outside ZDR. Compaction stays off too,
because `max_iterations` bounds the run, and compaction would be a separate
step with its own preserved-thinking checks.

### Every Inflect control, mapped

| Inflect control | Mechanism in this driver |
| --- | --- |
| The funnel decides | each tool's `run` validates with the MCP tool's own `argsSchema` (one catalogue; `betaTool` does not validate), then calls `runGuardedTool` |
| Advertised set | `offerToolSet` output (`src/lib/agentic/engine-tools/`, the engine-neutral core shared with Flue since Step 0a), with a builder that hands each tool over as JSON schema |
| Kill switch every turn | checked in the loop body on every yielded message, and again inside each `run` (step 0 of `authorizeToolCall` already does) |
| Run caps | charged inside each `run`; `max_iterations` and the signal are backstops. A tool must honour `signal`, because the runner waits for it |
| `MODEL_CALL` + Art 12 | one per yielded message: digest from `runner.params`, usage from `msg.usage` |
| Guard on model text | egress-scanned in the loop body. Flue cannot do this |
| `TOOL_CALL` step | written in the `run` wrapper, serial by `disable_parallel_tool_use` |
| Skills | an Inflect-owned `activate_skill` tool. The catalogue goes in the system prompt, and the tool returns the pinned, hash-checked instructions. Progressive disclosure without files |
| Delegation | on, inline and subset-only (owner decision 4 of 2026-10-30 in `docs/claude-agent-sdk-design.md`), built in Step 2e. An engine-supplied `delegate` tool, offered only when the version defines sub-agents, whose `run` drives a nested runner on the **same client** with a subset of the parent's offered tools and mounted skills, depth 1, the fan-out cap from `subagent-fanout-policy.ts`, and every step, call, token and millisecond charged to the parent run. See **Delegation** below |
| Residency | `clientForRun`: `new Anthropic({ apiKey, defaultHeaders: anthropicWorkspaceHeaders(…) })` per run for `EXTERNAL`. `LOCAL_ONLY` is refused unless the gateway speaks the Anthropic protocol |
| In-memory state | none beyond the run's own loop; `thread: false` |
| Tests | network-free via the client's `fetch` override, through the same driver conformance suite as every other engine |

### What changes in Inflect's code

- `package.json` gains `@anthropic-ai/sdk` 1.x as a **direct** dependency. It
  sits beside pi-ai's pinned 0.129.0, and `docs/dependency-risk-review.md`
  records both. 1.3.0 ships a `require` condition and loads under Jest's
  CommonJS `node` project (Step 2a), so the dynamic-import boundary Flue needs
  (`flue/driver.ts`) is not needed here.
- `AGENT_DRIVERS` gains `'tool-runner'`, with the env switch
  `AGENT_DRIVER_TOOL_RUNNER` (opt-in, read like `AGENT_DRIVER_FLUE`) and a
  `DRIVER_IMPLEMENTED` entry. `AgentDriverMode` gains `TOOL_RUNNER` in two
  deploys.
- `src/lib/agentic/tool-runner/` holds `driver.ts`, `execute.ts`,
  `params.ts`, `client.ts` and `tools.ts`, over the engine-neutral tool core
  from Step 0a.
- `docs/sub-processors.md`: the Anthropic row's agent-run purpose names this
  engine and the "tenant-authored agent instructions" category, the same entry
  the Agent SDK design adds.

### What it does to the assistant

Nothing, by recommendation. The assistant's loop is provider-neutral, and the
owner chose that in #3808.

This research turned up one defect, which Step 2x (#4183) fixed: the message
builder in `tool-loop.ts` dropped `thinking` blocks between turns. On Opus 5.5
those blocks carry the model's reasoning, and its progress notes between tool
calls. The API expects them back unchanged, and drops, unbilled, any block a
model cannot read.

The Anthropic provider now hands the loop the reply's content as an opaque
`providerPart`, which only that provider reads. `buildMessages` replays that
content exactly as returned, so the next request carries every block, in order.
A provider that sets no part gets the history it always got.

## Delegation

This section is the design for Step 2e, written before any code under that
step's Part 1. It carries out the owner's decision 4 of 2026-10-30 in
`docs/claude-agent-sdk-design.md`: delegation is on in v1, inline, subset-only
and one level deep. Points this design could not settle alone are listed at the
end, under **Open questions for the owner**, each with a proposed answer. The
step's code waits for them.

### What is reused from Flue, and what differs

Flue has delegated since #3473, to four specialists defined in code
(`flue/subagents/index.ts`) through the runtime's own `task` tool. The Tool
Runner reuses every piece of that work that is not Flue-shaped:

| Reused as is | Where |
| --- | --- |
| The fan-out arithmetic and the sentence the model reads | `evaluateFanOut`, `fanOutRefusalMessage` (`subagent-fanout.ts`) |
| The tenant's cap, and its failed-read rule (unreadable is 0, owner decision 2026-11-12) | `readFanOutCap` (`subagent-fanout-policy.ts`) |
| The span grouping on the run page | `delegationSpans`, `delegatesClaiming` (`delegation-spans.ts`) |
| The marker step's input shape (`agent`, `taskId`, `fromSeq`) | read by `delegationOf` (`run-step-projection.ts`) |
| The subset rule: a child's set is a filter of the parent's, never re-derived from the register | the invariant `narrowTools` / `narrowSkills` hold |
| The answer scan on re-entry | `guardDelegateAnswer`, moved from `flue/tools-adapter.ts` into `engine-tools/` with a required source prefix (`'flue'` keeps Flue's source byte for byte), because the Tool Runner may not load a valibot module |

It differs from Flue in six places, each for a stated reason:

- **The sub-agents are tenant-authored, approved and hashed.** Flue's are code,
  reviewed in a pull request. Here they are part of an `AgentProfileVersion`, so
  they inherit its lifecycle, its four-eyes approval and its content hash.
- **Depth 1 is structural, on our side.** Flue relies on the specialists
  declaring no nested `useSubagent`. Here `delegate` is Inflect's own tool,
  added beside the parent's tools and never to a child's, so a child's request
  carries no tool that could delegate.
- **Fan-out is counted in our own tool's `run`**, in a map that lives for one
  segment, keyed by the parent's turn number. Flue has to count in the runtime's
  interceptor, in a module-level map, because `task` is not its tool.
- **A child's tool calls carry their own guard source.** Flue's delegates run
  the parent's own tool objects, so their rows read `flue-tool-args:…`. Here
  the child's set is built with a source naming the sub-agent (below), over the
  parent's latch.
- **Every child step is labelled in its own column**, not only inferred from a
  span. Serial dispatch makes the span exact here too, but a run killed during
  a delegation never writes the marker that closes the span, and its child
  steps must still say whose they were.
- **The task text is scanned on the way in, as well as the answer on the way
  out.** `delegate` is our tool, so its argument passes the egress slice every
  funnel argument passes. Flue does not scan `task`'s argument. The answer gets the injection scan only: it is the child's last
  message, already egress-scanned in the child's loop.

Flue also has a worker-model override (`workerModelOverride`, D-L3-1). The Tool
Runner does not use one: a child runs on the parent's model tier and effort,
through the same client, so there is no second residency decision to make.

### 1. The model

**Storage: one encrypted column, `AgentProfileVersion.subagentsJson`**, not a
new table. It follows the `flowJson` precedent exactly:

- canonical JSON of a checked list, or `NULL` for a version with none. An empty
  list is stored as `NULL`, never `[]`, and a CHECK
  (`AgentProfileVersion_subagents_json_present`: `NULL` or non-empty) refuses
  the empty string;
- frozen with the rest of the version by `agent_profile_version_lifecycle()`,
  for every role;
- encrypted at rest: `src/lib/security/encrypted-fields.ts` lists
  `AgentProfileVersion: ['instructions', 'rejectionReason', 'flowJson', 'subagentsJson']`,
  and the column needs no new entry in `sanitize-rich-text-coverage`, whose
  `AgentProfileVersion` row already names this usecase and `sanitizePlainText`;
- written only by `usecases/agent-profiles.ts`, the table's one writer.

A child table was considered and declined. It would need its own RLS triple,
indexes, retention row, two-tenant test, single-write-seam entry and, above
all, its own freeze trigger, because a version is immutable as one unit and a
second table can be written after the first. One column inherits all of it.

**One sub-agent** (`src/lib/agentic/agent-profile.ts`, with a strict Zod schema
in `agent-profile.schemas.ts` that is the cheap first refusal):

| Field | Rule |
| --- | --- |
| `name` | `^[a-z][a-z0-9_]{1,39}$`, unique in the version. Snake case like a tool name, so it can sit in a guard source, a ledger column and an audit row as an identifier (see **Guard sources** below) |
| `description` | one line, at most 300 characters: what the parent reads when choosing. **Proposed**, see open question 2 |
| `instructions` | sanitised (`sanitizePlainText`), trimmed, non-empty, at most `PROFILE_INSTRUCTIONS_MAX_CHARS` (16,000), as the version's are |
| `toolNames` | non-empty, deduplicated, sorted, and every name one of the version's `toolNames` |
| `skillRefs` | deduplicated, sorted, and every ref one of the version's `skillRefs` |
| `maxTurns` | 1 to the version's own `maxTurns` |

At most `PROFILE_MAX_SUBAGENTS = 4` per version. The canonical form sorts the
list by `name` and writes each object's keys in the order above, so the stored
string, and therefore the hash, does not depend on the order the editor sent.

**At save**, in `prepareVersion`, after the version's own checks:

- each sub-agent's description and instructions go through `scanSkillText`
  with `declaredTools` set to that sub-agent's own `toolNames`, so text naming a
  tool outside its subset is refused by `skill.undeclared_tool`, exactly as the
  version's text is held to the version's tools;
- every rule above is a refusal **by name**, never a silent drop. The reasons
  are `SUBAGENTS_TOO_MANY`, `SUBAGENT_NAME_INVALID`, `SUBAGENT_NAME_DUPLICATE`,
  `SUBAGENT_INSTRUCTIONS_EMPTY`, `SUBAGENT_INSTRUCTIONS_TOO_LONG`,
  `SUBAGENT_INSTRUCTIONS_REFUSED` (with rule ids), `SUBAGENT_NAMES_NO_TOOL`,
  `SUBAGENT_TOOL_NOT_IN_VERSION`, `SUBAGENT_SKILL_NOT_IN_VERSION` and
  `SUBAGENT_MAX_TURNS_ABOVE_VERSION`, all 400, each with the sub-agent's name
  and the offending tools or skills in `details`;
- a version with a flow and sub-agents together is refused
  (`SUBAGENTS_WITH_FLOW`) until open question 1 is answered.

The version's own grant, skill and catalogue checks need no change: a
sub-agent's tools and skills are subsets of the version's, so a version whose
sets pass already covers its sub-agents.

**At approval**, everything above is asked again, as the version's own checks
are, because the text scan's rules can change while a version waits.

**Audit rows** (`AGENT_PROFILE_*`) gain the sub-agents' names, count and tool
names. They never carry a description or instructions.

**The content hash.** `instructionsHash` already covers the flow when there is
one (`profileContentHash`). It gains a third argument and a second domain:

```text
no flow, no sub-agents  sha256(instructions)                                         unchanged
flow, no sub-agents     sha256(JSON(['inflect-agent-profile-content/1', instructions, flowJson]))   unchanged
any sub-agents          sha256(JSON(['inflect-agent-profile-content/2', instructions, flowJson ?? null, subagentsJson]))
```

The hash is taken over the stored plaintext string, not over a re-serialisation,
so a later build that canonicalises differently cannot move it. A version with
no sub-agents stores `NULL` and takes one of the first two arms, byte for byte
what it has always taken, so **no existing version's hash changes**: every
approved version, every run pin (`profileInstructionsHash`) and every hash an
approver has named still verifies. Changing only one sub-agent's text changes
the hash, which the resolver reports as `PROFILE_HASH_MISMATCH` and approval as
`HASH_CHANGED`, as it does for the instructions today.

**The resolver** (`compileProfileDefinition`) reads the column back strictly,
like a flow. A list this build cannot parse, or one whose sets are no longer
subsets of the version's own, compiles to nothing and the run is refused, never
run as a version without sub-agents. `ProfileRunSpec` gains
`subagents?: readonly ProfileSubagentSpec[]`.

**Which engines run them.** `agent-profile.ts` gains `RUNS_SUBAGENTS`, a
`Record<AgentDriver, boolean>` beside `RUNS_PROFILES` and `RUNS_FLOWS`, so a new
driver is a compile error until it is classified. Admission refuses a version
with sub-agents on an engine whose entry is false
(`PROFILE_SUBAGENTS_NOT_RUNNABLE`), before the run row exists, and the Test run
view gains the same reason. A version with sub-agents is never run as though it
had none. The Tool Runner's entry turns true in its own commit, so reverting
that commit is the rollback, and it leaves every sub-agent version refused by
name rather than run without its delegates. Flue's stays false: Flue runs no
profile (decision 7), and decision 4 leaves how a later engine maps the inline
definition to that engine's own steps.

**The migration** (one, additive, forward-only):

1. `ALTER TABLE "AgentProfileVersion" ADD COLUMN "subagentsJson" TEXT` and its
   presence CHECK. Every existing row is `NULL`, so the CHECK holds at once.
2. `CREATE OR REPLACE FUNCTION agent_profile_version_lifecycle()`, with
   `subagentsJson` added to the re-wrap exception (ciphertext to `v2:`
   ciphertext, every other column unchanged) and to the frozen columns. This is
   **required in the same migration**: the current function freezes listed
   columns, so without the replacement a new column could be rewritten on an
   approved version.
3. `ALTER TABLE "WorkflowStep" ADD COLUMN "subagentName" TEXT`, and the CHECK
   `WorkflowStep_subagent_name_shape` (`NULL` or the name pattern above), added
   `NOT VALID` and then validated in a second statement. Every existing row is
   `NULL`, so validation cannot fail; the split is for the lock, because
   the step ledger grows with every run and a plain `ADD CONSTRAINT` scans the
   whole table under an exclusive lock.

**No two-deploy split is needed**, and the reason is worth keeping. The rule
binds a new enum value, which a Prisma client not generated with it fails to
read. These are two nullable `TEXT` columns, which an older client never
selects. During a rolling deploy an older container cannot run a sub-agent
version wrongly either: it recomputes the hash without the sub-agents, gets a
different value, and refuses (`PROFILE_HASH_MISMATCH` at the resolver,
`HASH_CHANGED` at approval). The older lifecycle function is replaced in place
and every write the older image makes leaves the new columns `NULL`, so nothing
it does is refused.

**In-flight runs** of versions approved before the change pinned a version with
`subagentsJson` `NULL`. Resumed on the new build, they recompute the same hash,
compile with no `subagents`, are offered no `delegate`, and send exactly the
request they sent before: `lockedParams` adds nothing for a version without
sub-agents, and its guard is extended to pin that a version with none produces
the same parameters as today. A run admitted on the new build for a version with
sub-agents and resumed on an older worker fails its hash check and settles with
the resolver's named reason. Nothing runs half-delegated.

### 2. The `delegate` tool

`delegate` is engine-supplied, like `activate_skill`. It lives in
`tool-runner/delegate.ts` and is offered to the **parent only**, beside its
resolved tools and after the empty-catalogue check, and only when
`def.profile.subagents` is non-empty. `TOOL_RUNNER_SUPPLIED_TOOLS` gains its
entry with a new `RuntimeToolCondition`, `'when-subagents-defined'`, so the
agent's Tools tab reports it beside `activate_skill`; its `boundedBy` sentence
says that it reaches only the subsets the version's approver read.

Its input schema:

```json
{ "type": "object",
  "properties": {
    "subagent": { "type": "string", "enum": ["<the version's sub-agent names>"] },
    "task":     { "type": "string", "minLength": 1, "maxLength": 8000 } },
  "required": ["subagent", "task"], "additionalProperties": false }
```

The tool's description lists each sub-agent as `name: description`, so the
parent's system prompt, and its cached prefix, are unchanged for a version
without sub-agents. A name outside the enum is refused `SUBAGENT_NOT_DEFINED`
without echoing it, as `activate_skill` answers `SKILL_NOT_MOUNTED`.

A child is never offered `delegate`. Its tools are a filter of the parent's
offered set, which never contains an engine-supplied tool. If a model names
`delegate` anyway, the SDK answers `Error: Tool 'delegate' not found` and runs
nothing; the child loop also records that request as a `FAILED` `TOOL_CALL`
step, `refused: SUBAGENT_TOOL_NOT_OFFERED`, so the refusal is in the ledger
rather than only in the conversation. The same applies to any tool name outside
the child's set.

### 3. The nested loop

A delegation, in order, inside the parent's serial queue:

1. **A stop already latched** (cap, kill, operator abort, guard) refuses the
   call, as every tool does.
2. **One step is charged** (`STEPS`, like an activation; not `TOOL_CALLS`,
   because `delegate` is not a funnel call). Every recorded step is charged.
3. **The arguments**: the name in the enum, the task within its bounds.
4. **Fan-out.** The cap is read once per segment with `readFanOutCap`, so an
   unreadable settings row is 0, and a stored 0 is 0. `evaluateFanOut` counts
   delegations in the parent's current turn (the number of the parent's yielded
   message), on the way in. A refusal reads `fanOutRefusalMessage`: at 0 it says
   delegation is disabled and not to retry, so the model carries on alone. The
   tool stays offered at 0, as `task` does on Flue, so the refusal is a ledgered
   step an operator can see rather than an absence nobody can.
5. **The task's egress scan** (`guardEgress`, source
   `tool-runner-delegate-args:<name>:<toolUseId>`), noted through the run's
   observer. Anything but clean stops the run at the guard.
6. **The kill switch and the breaker**, uncached. A kill latches the run's
   stop. An `OPEN` breaker refuses the delegation
   (`subagent_breaker_open`), as the funnel refuses every call while it is open.
7. **The child's tools**: `offerToolSet` over the parent's own invocation, with
   `profileTools` set to the sub-agent's `toolNames`, the parent's `readOnly`,
   observer and origin resolver, the sub-agent's guard source, and **the
   parent's review latch**. The engine-neutral core gains an optional `review`
   input for that, because two latches in one run is the routing-around the
   latch exists to stop. The result is then intersected by name with the
   parent's offered set, so the subset is a property of the code and not of two
   calls agreeing. Each tool lost is listed with its reason. A child left with
   no tools is refused (`subagent_has_no_tools`) and nothing is sent.
8. **The child's skills**: the parent's resolved documents and row pins,
   filtered to the sub-agent's `skillRefs`. Nothing is resolved again and
   nothing new is pinned: the run's `mountedSkills` is the version's set, and
   a child's is a subset of it. The child gets its own `activate_skill` over
   that subset. Its catalogue is measured with `catalogBytes` against
   `MAX_CATALOG_BYTES` before it is sent. That cannot fail for a subset of a
   priced set, and the check stays as the guard against a future change that
   breaks the subset.
9. **The child runner**, on the **same client** (one client per run, so
   residency is the parent's and cannot race), from `lockedParams` with a
   `subagent` option, so it is still the one function that shapes a request
   and its guard pins the child's values as well: `thread: false`, serial
   `tool_choice`, the parent's model tier, effort, thinking and fallbacks;
   `max_iterations` is the lower of the sub-agent's `maxTurns` and the run's
   remaining `STEPS`. The system prompt is Inflect's preamble with one added
   paragraph (you are a sub-agent named so, you work for the agent that
   delegated, you cannot delegate, answer in plain text), then the child's
   catalogue, then its instructions fenced as
   `<operator_instructions source="agent-profile-subagent" name="…">`. The one
   user message is the task, fenced and labelled as written by the delegating
   agent. The child sees the task and nothing else of the parent's
   conversation, including the run's declared input. The request's signal is
   `AbortSignal.any([parent, child])`, so every stop the parent latches aborts
   a child request in flight, which matters because the runner waits for a
   running tool and `delegate` is that tool.
10. **The child's answer**: its last message's text, scanned by
    `guardDelegateAnswer` (prefix `tool-runner`), and returned fenced as
    `<subagent_answer name="…">`.
11. **The marker step**, in `finally`, closing the span (below), and then the
    kill switch read, as after every tool call.

**The child's loop body is the parent's.** The per-message checks in
`execute.ts` (egress scan, `MODEL_CALL` step and Art 12 row, the verdict noted
before the caps, kill and operator abort, latched stops, token and wall-clock
caps, named stop reasons) move into one function both loops call, with the
sub-agent's name as a parameter. A second copy would drift, which is the
defect this repository keeps paying for. Two additions are the child's: each
child model call charges one `STEPS`, and the breaker is read with the kill
switch.

**Where the caps bind.** The child shares the parent's `RunBudget`, its ledger
counter and its run state:

- `STEPS`: the delegation, each child model call, each child tool call and
  each child activation;
- `TOOL_CALLS`: each child funnel call;
- `PROPOSALS`: each item a child proposes, when the run is not read-only;
- `TOKENS`: every child call's usage, added to the run's `costTokens`, which
  is persisted after every child message as after every parent message;
- `RUNTIME_MS`: the run's wall clock, checked at the delegation and after every
  child message.

A cap, a kill, an operator's abort or a guard verdict found anywhere in the
child latches the **run's** stop and aborts both signals, and the parent's
existing settlement settles the run, in its existing order. A child's own end
is not the run's end: a child's `refusal`, `max_tokens` or full context, and a
child that reaches its `maxTurns` still calling tools
(`subagent_turns_exhausted`), each return an error to the parent naming the
reason, and the parent decides what to do, as with any failed tool.

**Identity.** Every child call goes through `runGuardedTool` on the parent's
invocation: the parent agent's identity, grants, card, scopes, autonomy
ceiling and kill switch. A sub-agent is not a principal and has no switch of
its own. A child's proposal is the parent agent's proposal; its origin names
the child's step, which carries the sub-agent's name.

**readOnly, output kind and residency** are the parent run's. A Test run, an
`ANSWER_ONLY` version and a read-only flow compile to `readOnly`, and the
child's set is built with the same flag and runs on a context carrying
`readOnlyRun`. Residency is the client's. A `LOCAL_ONLY` tenant never reaches a
delegation, because `clientForRun` refuses the run before the first request.

**Guard sources.** `runGuardedTool` takes the prefix and is not changed. The
child's prefix is `subagentGuardSource(name)` = `tool-runner-subagent.<name>`,
exported beside `TOOL_RUNNER_GUARD_SOURCE`, so its rows read
`tool-runner-subagent.risk_analyst-tool-args:list_risks:toolu_…`. They still
begin with the engine's name, and because the name pattern admits no `-`, `:`
or `.`, the name ends exactly at the first `-tool-`. The child's model text is
scanned under `tool-runner-subagent.<name>-model-output:<runId>:<n>`. The name
reaches the hash-chained audit row and the SIEM stream as an identifier, as a
tenant skill's name and a tool name already do; the pattern is what keeps it
one.

**Sub-processor.** No new data category goes to Anthropic. A sub-agent's
instructions are "tenant-authored agent instructions", which the Anthropic row
already names, and the task and the answer are model text built from tool
results that already travel there. The pull request says so and quotes the row.

### 4. The ledger and the run page

**One new column, `WorkflowStep.subagentName`**, written by `recordStep` (still
the one writer) from a new `subagent` field on `StepRecord`, and copied into
the step's hash-chained `WORKFLOW_STEP` audit row as `subagent`. It is set on
every `MODEL_CALL` and `TOOL_CALL` a child produces, activations and refusals
included, and `NULL` on every parent step. A column, not `inputJson`: a
`TOOL_CALL`'s input is the arguments the model chose, which the projection reads
for the data rung, and a key added to them could not be told from an argument
of the same name. `AiDecisionLog` is unchanged: a child's Art 12 row is found
through the digest its labelled `MODEL_CALL` step names, which is how every row
is found today.

**The marker.** The delegation is a `TOOL_CALL` step naming `delegate`, written
when it ends, so its own `seq` closes the span. Its input is Flue's marker
shape, `{ agent: <name>, taskId: <the model's tool_use id>, fromSeq }`, plus
`taskChars` and the tools lost at step 7; its output names the outcome
(`answered`, a refusal reason, or the run's stop) and the child's model-call and
tool-call counts. It never carries the task or the answer: both are model text
composed from tenant reads, and this column is the step's plaintext payload
(`no-raw-prompt-logging`). A refused delegation is a `FAILED` marker with the
reason. A kill during a delegation still writes the marker, from `finally`,
before the parent settles.

**The run page.** `delegationOf` recognises `delegate` beside `task`, so the
existing **Delegations** panel groups a Tool Runner run with no change to
`delegationSpans`. The projection gains `subagent: string | null` from the
column, and the timeline badges each child step with it directly, so a step's
owner is read, not inferred, wherever the column is set. Strings go in
`messages/en.json` and `messages/bg.json`.

### 5. The Behaviour editor and the approval view

- **The editor** (`BehaviourEditorSheet.tsx`) gains a **Sub-agents** section
  below the tools and skills, built from the platform's `Accordion`,
  `FormField`, `Combobox` and `NumberStepper`. At most four entries, each with a
  name, a description, instructions, a tool picker, a skill picker and a turn
  limit. The pickers offer **only what the version being edited has selected**,
  never the agent's wider grants, and the turn limit is bounded by the
  version's. Deselecting a tool or skill a sub-agent uses marks that sub-agent
  in place; the server still refuses by name, because the editor is not the
  authority.
- **The approval view** (`BehaviourTab.tsx`) shows every sub-agent of the
  submitted version: name, description, tools, skills, turn limit and
  instructions, as text in `<pre>`, never markup. `describeSubagentsForReview`
  renders the list in name order, and `VersionDiff` diffs it against the
  version in force, as `describeFlowForReview` does for a flow. The hash note
  says what the hash covers (`review.hashNoteWithSubagents`), and Approve sends
  the hash on screen, so the approver approves every word a run of the version
  can send.
- **The version history** shows a sub-agent count beside each version. The
  Test run is unchanged: it starts the same read-only run, which may delegate.

### Open questions for the owner

Each is a point decision 4 does not settle. The proposed answer is the one this
design is drawn to.

1. **The flow's `subagent` node and inline sub-agents.** Phase 1 of
   `docs/ai-architecture/langflow.md` shipped a flow node kind `subagent` whose
   `profileRef` names **another approved profile** in the tenant, which is
   delegation to another agent's text, not inline. No engine runs a flow today
   (`RUNS_FLOWS` is false everywhere). Options: (a) a version may carry a flow
   or sub-agents, not both, in 2e, and langflow's Phase 5 re-points the node at
   one of the version's own sub-agent names; (b) at save, a `profileRef` is
   copied into the version as an inline sub-agent, its text frozen and hashed
   with the version; (c) a `profileRef` delegates to the other agent under that
   agent's own identity and grants. **Proposed: (a).** It keeps decision 4's
   rule that the approver of a version reads all the text it runs, and that a
   sub-agent's tools are a subset of its parent's, which a reference to another
   agent's profile cannot promise. (b) imports another agent's text under this
   agent's authority. (c) is a second authority model.
2. **A sub-agent's `description`.** Decision 4 names instructions, tools,
   skills and a turn limit. Without a description the parent chooses by name
   alone. Options: (a) a required one-line description, at most 300
   characters, scanned and hashed with the instructions; (b) the name only;
   (c) the instructions' first line. **Proposed: (a).** It is the catalogue
   line Flue's specialists and every skill already carry, and (c) puts part of
   the child's instructions into the parent's context.
3. **A per-run bound on delegations.** The tenant's cap counts per parent
   turn. Under serial dispatch a turn holds one tool call, so the cap binds
   only at 0, or when a fallback model ignores `disable_parallel_tool_use`.
   Options: (a) per turn only, as on Flue, with the run's `STEPS`, `TOKENS` and
   wall clock as the whole bound; (b) also a fixed per-run cap in code;
   (c) also a per-run tenant setting. **Proposed: (a)**, with the settings copy
   saying that on this engine the cap works as on or off. Every delegation is
   already charged to the run's caps, and a second knob is a second thing to
   misread.
4. **Whether the parent's loop changes with the child's.** The step asks for
   the breaker before each child model call, and for each child model call to
   be charged to `STEPS`. Neither is true of the parent today: the parent reads
   only the kill switch between calls (the funnel asks the breaker on each tool
   call), and its in-segment `STEPS` counts tool calls and activations, while
   model calls are bounded by `max_iterations`. Options: (a) the child only, as
   the step says; (b) both loops, through the shared loop body; (c) the child
   now, the parent in a separate issue. **Proposed: (b).** One loop body with
   two behaviours is the drift the shared body exists to prevent, and both
   changes only narrow. It does mean a parent run can halt at `STEPS` sooner
   than it does today, which is a change to a behaviour Step 2H recorded in
   production.

## Decisions for the owner

1. **Make this the builder's first engine.** **Decided (owner, 2026-10-25):
   yes**, in place of the Agent SDK, for the reasons in the table at the top. The Agent SDK design's Step 4a
   becomes a confirmation spike, run only if a profile needs that engine.
2. **Serial tool dispatch in v1.** **Decided (owner, 2026-10-25): serial.**
   `disable_parallel_tool_use` costs extra turns
   on fan-out-heavy work. A per-run mutex inside `run` keeps the ledger exact
   and allows parallel requests, at the price of a lock to get right. v1 takes
   the simpler shape.
3. **A direct SDK dependency.** **Decided (owner, 2026-10-25): take the
   dependency** (`@anthropic-ai/sdk`, Step 2a). It adds one package the repo already carries
   transitively. The alternative, extending the raw-`fetch` provider pattern
   into a full agent loop, is #3808's choice for the assistant. It does not
   carry over: an engine for customer-built agents gains a lot from the SDK's
   handling of `pause_turn`, refusal fallbacks and thinking blocks.
4. **`LOCAL_ONLY` tenants.** **Decided (owner, 2026-10-25): refused on this
   engine with a named reason, and served by Flue.** An Anthropic-compatible local gateway would lift
   the refusal without a code change.

## Roadmap (future direction)

This document owns **Phase 2** of the plan for the three Claude agent designs.
How to use the plan, the phase map, the **global rules**, the **definition of
done** and the operational-evidence table are in the Roadmap of
`docs/claude-agent-sdk-design.md`. They bind every step here, and the prompts
point there rather than restating them. Phase 2 starts when Phase 1's hardening
step (1H) is merged.

| Step | Title | Depends on | Change class |
| --- | --- | --- | --- |
| 2a | Dependency and per-run client | 1H | Significant — new runtime dependency |
| 2b | Tool Runner driver, reader-only | 2a | Significant — enum value, new engine |
| 2c | Turn the Tool Runner engine on | 2b deployed | Significant — enables an engine, new data category at a sub-processor |
| 2d | Skills on the Tool Runner engine | 2c | Standard (delivered, #4151) |
| 2H | Phase 2 hardening | 2a–2d | Standard |
| 2e | Inline sub-agents (delegation) | 2H | Significant — schema migration, new engine-supplied tool |
| 2x | Carry thinking blocks through the assistant's loop | — (independent) | Standard (delivered by #4183) |

### Phase 2 — Tool Runner engine

The first engine that runs the agents customers build. It is in-process, uses one
API client per run, and sends every tool call through the funnel.

#### Step 2a — Dependency and per-run client

**Goal.** Add the Anthropic SDK as a direct dependency, and make the only way to
get a client for an agent run a function that chooses it from the run's
residency.

```text
You are implementing Step 2a of the roadmap in docs/claude-tool-runner-design.md.
Read the global rules and definition of done in the Roadmap of
docs/claude-agent-sdk-design.md, then this document's "What the Tool Runner is"
and "What changes in Inflect's code". Read docs/dependency-governance.md,
docs/dependency-risk-review.md, src/lib/agentic/flue/model-selection.ts and
src/lib/ai/anthropic-workspace.ts. Phase 1 is merged.

Goal: @anthropic-ai/sdk 1.x in dependencies, and clientForRun as the single
constructor of Anthropic clients for agent runs.

1. Install @anthropic-ai/sdk at the current 1.x release with a normal npm
   install, then:
   - follow the dependency checklist in the pull-request template;
   - record it in docs/dependency-risk-review.md, with its REVIEWED guard entry if
     the review process requires one;
   - note that pi-ai keeps its own pinned 0.129.0 copy.
   Check whether the package resolves under the node jest project's require. If
   it does not, put the engine behind a dynamic-import boundary the way
   flue/driver.ts does, and say so.
2. src/lib/agentic/tool-runner/client.ts exports clientForRun(selection), built
   on the same residency terms flue/model-selection.ts reads:
   - EXTERNAL → new Anthropic({ apiKey, defaultHeaders:
     anthropicWorkspaceHeaders(...) }), built per call, never cached across
     tenants;
   - LOCAL_ONLY → refused with a named reason (TOOL_RUNNER_LOCAL_ONLY_UNSERVED),
     unless an Anthropic-compatible local endpoint is configured, which is
     not the case today;
   - no key configured → refused with a named reason.
3. Model ids per tier come from configuration with defaults: claude-sonnet-5-5
   for the balanced tier and claude-opus-5-5 for the deep tier. Triage every new
   env var per global rule 6.
4. A structural guard: no file under src/ outside tool-runner/client.ts
   constructs an Anthropic client from this package, and none calls a
   process-wide provider setter. Prefer an ESLint no-restricted-syntax selector
   (eslint-rules/README.md).

Tests: each residency branch, including the refusals; two concurrent calls for
two tenants get two clients with their own headers; the guard catches a planted
construction.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The dependency checklist in the pull-request body is complete, and `npm audit` (moderate+) and the security gate stay green.
- [ ] A `LOCAL_ONLY` tenant is refused with a named reason and no client is built: the test asserts the constructor was never called.
- [ ] Two concurrent runs for two tenants never share a client instance (test).
- [ ] The guard against a second construction site is proven by planting one.
- [ ] Every new env var is triaged, and `sub-processor-coverage` stays green.

**Exit.** An agent run can obtain an Anthropic client only through `clientForRun`, chosen by the run's residency.

#### Step 2b — Tool Runner driver, reader-only

**Carried from Step 1a (#4143).** This engine is the first that may run an agent
profile. Its `runsProfiles` entry (`src/lib/agentic/agent-profile.ts`) stays
false in this step and is set true with the engine in 2c, and the driver must
already do three things:
- render `def.profile.instructions` as the operator's fenced block;
- pass `def.profile.toolNames` to `offerToolSet` as `profileTools`;
- route resume and settlement through `resolveRunDefinition`, because a profile
  run key is not in the registry.

**Carried from Step 2a (#4148).** The client the driver gets from
`clientForRun` speaks API version `2026-10-21` and refuses some requests itself.
So the driver must:
- send no `temperature`, `top_p` or `top_k` (a 400 on that version, on every
  model), no `document` block in an assistant turn, and no `text` block with
  `citations` in a user turn, tool results included;
- hand the runner custom tools only, built from `offerToolSet`. The client
  refuses a server tool, an Anthropic-defined tool, `mcp_servers`, `container`
  and `thread`, so a toolset or parameter that needs one fails the run rather
  than reaching Anthropic;
- still set `thread: false` on the runner, which the client then holds;
- turn each `clientForRun` refusal into a named run-start refusal, and take the
  model from `toolRunnerModelFor(profile.modelTier)`.

**Goal.** Build the complete driver behind `DRIVER_IMPLEMENTED = false`, and ship
the `TOOL_RUNNER` enum value with no writer.

```text
You are implementing Step 2b of the roadmap in docs/claude-tool-runner-design.md.
Read the global rules and definition of done in the Roadmap of
docs/claude-agent-sdk-design.md, then this document's sections "How it would sit
in Inflect", "The locked parameters" and "Every Inflect control, mapped". Read
src/lib/agentic/flue/driver.ts, flue/execute.ts, flue/model-decision.ts,
src/lib/agentic/drivers/ and the Step 0b conformance suite. Step 2a is merged.

Goal: a tool-runner driver that passes the conformance suite and that the gate
cannot select yet.

1. Add 'tool-runner' to AGENT_DRIVERS, classify it in isReasoningEngine, add the
   env switch AGENT_DRIVER_TOOL_RUNNER (opt-in, read like AGENT_DRIVER_FLUE),
   and set DRIVER_IMPLEMENTED to false for it. Add TOOL_RUNNER to
   AgentDriverMode as a reader-only value: coerceStoredDriverMode understands
   it, and no writer accepts it.
2. src/lib/agentic/tool-runner/:
   - driver.ts plans or refuses before execution;
   - params.ts holds lockedParams, exactly as the design's table:
     thread: false; tool_choice auto with disable_parallel_tool_use; adaptive
     thinking with display 'summarized'; max_iterations from resolveRunCaps;
     the fallbacks parameter on the first-party client; no server tools; no
     mcp_servers;
   - tools.ts makes one betaTool per resolved tool over the engine-neutral core.
     Each run validates with the MCP tool's argsSchema, then calls
     runGuardedTool, then charges the run budget and writes the TOOL_CALL step.
   - execute.ts holds the loop. For each yielded message:
     - the kill-switch check, then abort and haltRunAtKill;
     - a MODEL_CALL step and an AiDecisionLog row, with the digest of
       runner.params;
     - guardEgress on the message's text, then haltRunAtGuard on block or flag;
     - refusal, max_tokens and context-exceeded stop reasons settled with named
       reasons.
3. The system prompt is Inflect's fixed preamble plus the pinned profile
   instructions, fenced and labelled as the operator's text, with a cache
   breakpoint after it.
4. A guard pins lockedParams value by value. Removing thread: false or
   disable_parallel_tool_use, or adding a server tool, fails it.
5. Run the conformance suite against a faux client, using the client's fetch
   override, so no network is involved.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The conformance suite passes, and every scenario is mutation-proved against this driver.
- [ ] Every outgoing request carries `thread: false`, asserted on the request body the faux transport receives, not on the options object.
- [ ] Tool calls are dispatched one at a time: the ledger's `TOOL_CALL` sequence matches call order under a faux model that asks for three tools in one turn.
- [ ] Each yielded message produces exactly one `MODEL_CALL` step and one decision row whose digest matches `runner.params` (test).
- [ ] A refusal stop reason settles the run with a named reason and runs no tool from that turn.
- [ ] With `DRIVER_IMPLEMENTED` false, no input selects this engine (`agent-driver-gate` grid extended), and a stored `TOOL_RUNNER` reads as that mode while no writer accepts it.
- [ ] The rollback plan and risk assessment are in the pull request.

**Exit.** The driver exists, is conformance-proven, and cannot run.

#### Step 2c — Turn the Tool Runner engine on

**Carried from Step 1b (#4144).** The builder's Test run is in the Behaviour
tab and is disabled. This step builds what enables it:
- **A start route.** Admission resolves only the approved version in force, and
  a browser session carries no agent identity, so a Test run needs its own
  route. That route binds the agent, as `agent-invoke-dispatch` does. It admits
  the version it names, a SUBMITTED one included, under the `TEST_RUN` trigger,
  read-only, and it refuses a version whose `allowedTriggers` lacks `TEST_RUN`.
- **The view's other state.** `getAgentProfile`'s `testRun` has one state today,
  `{ available: false, reason: 'NO_ENGINE_RUNS_PROFILES' }`. This step adds the
  state where a run can start. It also adds a reason naming the tenant's engine
  choice, for a tenant whose chosen engine does not run profiles.
- **The button's action.** It starts the run and opens it in the Runs tab.

**Carried from Step 2b (#4149).** The driver is built; these are what turning it
on still needs, beyond the flag:
- **The enum's second deploy.** Move `TOOL_RUNNER` from READ_ONLY to WRITTEN in
  `tests/unit/agent-driver-mode-rollout.test.ts`, and add it to
  `AGENT_DRIVER_MODES`. Both go in the same pull request as the flag flip.
- **Profiles ask for this engine.** `resolveRunDefinition` compiles a profile
  definition with `driver: 'flue'`. It must ask for `'tool-runner'`, and
  `runsProfiles` must say true for it, in the diff that records the data category.
- **The fourth gate.** `narrowToWhatAWorkflowAsksFor` narrows only `flue`. Teach
  it the tool runner, whose requests come from profile definitions rather than
  the workflow registry.
- **The settings copy is engine-aware.** The reason sentences
  (`ENV_DISABLED`, `DRIVER_NOT_IMPLEMENTED`, …) and the wiring checklist name the
  Flue engine. A tenant who chose this one needs sentences that name it.

**Goal.** One deploy after 2b, let a tenant choose the engine and run a profile on it.

```text
You are implementing Step 2c of the roadmap in docs/claude-tool-runner-design.md.
Read the global rules and definition of done in the Roadmap of
docs/claude-agent-sdk-design.md, and this document's "Decisions for the owner".
Step 2b is merged AND deployed to production. Before writing the enum value
anywhere, confirm that the deployed image carries it, and record how you
confirmed it.

Goal: DRIVER_IMPLEMENTED['tool-runner'] is true, the engine settings page (0c)
offers it, and the builder's Test run works on it.

1. Flip the flag in its own commit, with nothing else in it.
2. setAgentDriverSetting and the PUT schema accept TOOL_RUNNER. The settings page
   offers it with one sentence on what it is and "Powered by Claude".
3. The builder's Test run button (1b) is enabled when the tenant's engine runs
   profiles.
4. docs/sub-processors.md: the Anthropic row names this engine for agent runs and
   adds the data category "tenant-authored agent instructions", in this diff.
   Check "Decisions for the owner" for whether naming the category is enough. If
   the owner asked for a notice window, stop: this step waits for it.

Tests: an E2E spec on isolatedTenant that selects the engine, approves a profile
as a second user, starts a Test run and sees it complete in the Runs tab (E2E
mode uses the faux client); the gate grid's affirmative case.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] The flag flip is its own commit and reverts on its own.
- [ ] The pull request says how the deployed image was confirmed to carry `TOOL_RUNNER` before this merged.
- [ ] `docs/sub-processors.md` changes in the same diff, and its owner-decision check is quoted in the pull request.
- [ ] The E2E Test run completes, is read-only (no proposal rows), and shows `MODEL_CALL` and `TOOL_CALL` steps.

**Exit.** A tenant can choose the Tool Runner engine and test-run an approved profile on it.

#### Step 2d — Skills on the Tool Runner engine

**Goal.** A profile's skills reach the model with progressive disclosure through an
Inflect-owned tool, under the existing mount gate.

```text
You are implementing Step 2d of the roadmap in docs/claude-tool-runner-design.md.
Read the global rules and definition of done in the Roadmap of
docs/claude-agent-sdk-design.md, the "Skills" paragraph of CLAUDE.md's "Agentic
AI for IAM roadmap" section, docs/agent-skill-standard.md, and
src/lib/agentic/flue/skills/ (mount-gate.ts, resolve.ts, tenant-mount.ts).
Step 2c is merged.

Goal: an activate_skill tool on the Tool Runner engine that serves the run's
pinned skills, and nothing else.

1. Resolve and pin skills exactly as startWorkflowRun already does for a
   reasoning engine, through the mount gate. Do not write a second resolver.
2. Put the catalogue (name and description of each mounted skill) in the system
   prompt, after the fixed preamble and before the instructions, within the
   per-run catalogue budget.
3. activate_skill(name) returns the pinned skill's instructions after
   re-checking its hash. An unmounted or refused name is answered with an
   is_error result naming the reason. It is reported as an engine-supplied tool,
   like flue/runtime-tools.ts.
4. Add the scenario "a refused skill never reaches the model" to the conformance
   suite, and pass it here and on Flue.

Deliver per the Definition of done.
```

**Hardening**

- [ ] A skill whose decrypted text no longer matches its pinned hash is refused at activation (test).
- [ ] An unmounted skill name returns `is_error` and never another tenant's skill (two-tenant test).
- [ ] The catalogue stays within the per-run budget, and exceeding it refuses the run before the row exists.
- [ ] `activate_skill` appears in the run's reported tool set as engine-supplied.

**Exit.** Skills work on the Tool Runner engine through the same gate and pins as on Flue.

#### Step 2H — Phase 2 hardening

Delivered in two pull requests. #4537 made each request's shape observable and
recorded the adversarial read (no defect in any of the five questions). The
second recorded the production runs: completed, stopped by the kill switch, and
refused under `LOCAL_ONLY`, with no `thread` member on any request. See the
Phase 2 row of the Operational evidence table in `docs/claude-agent-sdk-design.md`
and `docs/implementation-notes/2026-11-12-agents-production-evidence.md`.

**Goal.** Prove the engine in production, under stop conditions, and against the
data rules it was built on.

```text
You are implementing Step 2H of the roadmap in docs/claude-tool-runner-design.md:
the hardening step for Phase 2. Steps 2a–2d are merged. Read the global rules,
definition of done and "Operational evidence" in the Roadmap of
docs/claude-agent-sdk-design.md, and all of Phase 2 here.

Goal: evidence that the engine behaves in production as the conformance suite
says it does.

1. Adversarial read of 2a–2d together. At least:
   - Can a run's client outlive the run?
   - Can two tool calls run concurrently despite serial dispatch, for example
     when a fallback model ignores disable_parallel_tool_use?
   - Can a fallback model's message skip the guard?
   - Can the system prompt carry another version's instructions?
   - Is thread: false on every path, including retries?
   Fix what you find, each with a test.
2. In the proving tenant, on this engine:
   - run an approved profile to completion;
   - run it again with the kill switch engaged mid-run, using the drill agent;
   - run it as a LOCAL_ONLY tenant and see the named refusal.
   Record each run id, its MODEL_CALL and TOOL_CALL counts, its decision row
   count, the tokens charged and the halt or refusal reason.
3. Confirm that no conversation was stored at Anthropic. Record the request
   bodies' thread value from the engine's debug log for one run (no prompt
   text), and state what was checked.
4. Update this document's Current state, the Phase 2 evidence row in the Agent
   SDK document, and CLAUDE.md's "Claude agent engines" section with the engine's
   invariants (thread: false, serial dispatch, clientForRun only).

Deliver per the Definition of done.
```

**Hardening**

- [ ] Each adversarial question is answered in the implementation note, with a test for each defect found.
- [ ] The kill-switch drill halted a production run before its next model call, recorded by run id and reason.
- [ ] The `LOCAL_ONLY` refusal was observed in production with its named reason.
- [ ] `thread: false` was observed on a production request, with the method recorded.
- [ ] The evidence row is filled from production, not from a test.

**Exit.** The Tool Runner engine has run customer-built agents in production, stopped when told to, and stored nothing at Anthropic.

#### Step 2e — Inline sub-agents (delegation)

**Goal.** A profile version can define sub-agents inline, and the Tool Runner
engine runs them through an Inflect `delegate` tool, with every authority rule
the parent run has. This is the owner's decision 4 of 2026-10-30 in
`docs/claude-agent-sdk-design.md`: on in v1, inline, subset-only, one level deep.

```text
You are implementing Step 2e of the roadmap in docs/claude-tool-runner-design.md.
Read the global rules and definition of done in the Roadmap of
docs/claude-agent-sdk-design.md, its "Decisions for the owner" decision 4, and
this document's Current state. Read src/lib/agentic/tool-runner/ (execute.ts,
tools.ts, skills.ts, supplied-tools.ts), src/lib/agentic/engine-tools/ and
src/app-layer/usecases/agent-profiles.ts. Step 2H is merged.

Part 1, before any code: write a "Delegation" section in this document's design
(not its Current state) that settles the points below, and stop for the owner
if one of them needs a decision the owner has not made.

Goal: inline sub-agents on the Tool Runner engine.

1. Model. A profile version carries at most 4 sub-agents, each with a name, its
   own instructions (sanitised, scanned by the skill text scan, encrypted,
   size-capped as the version's are), toolNames that are a subset of the
   version's, skillRefs that are a subset of the version's, and maxTurns no
   higher than the version's. A sub-agent naming anything outside the version's
   sets is refused at save by name, never dropped. The version's
   instructionsHash covers every sub-agent's instructions, so a reviewer
   approves all of the text the run will use. Approval re-checks all of it.
2. The delegate tool is engine-supplied, like activate_skill, and offered only
   to the parent when the version defines sub-agents. Its name parameter is an
   enum of the version's sub-agent names. A sub-agent is never offered
   delegate: delegation is one level deep.
3. A delegation runs a nested loop with the sub-agent's instructions and tool
   subset. Every tool call goes through runGuardedTool under the parent agent's
   identity, with a guard source that names the sub-agent. Steps, tool calls,
   tokens and wall clock are charged to the parent run's caps. The kill switch
   and breaker are asked before each child model call. readOnly, output kind and
   residency are the parent run's. The child's catalogue is measured against
   the per-run budget.
4. The ledger records the delegation as a TOOL_CALL step naming delegate, and
   the child's MODEL_CALL and TOOL_CALL steps as steps of the same run,
   labelled with the sub-agent. The run page shows them grouped under it.
5. The Behaviour editor gains a sub-agents section, whose pickers offer only
   the version's own tools and skills. The approval view shows every
   sub-agent's instructions.

Tests: save refusals for each subset rule and the cap of 4; the hash changes
when only a sub-agent's text changes; a conformance scenario where a sub-agent
asks for a tool outside its subset and is refused, and one where it asks for
delegate and is refused; the parent's caps halt a child loop; the kill switch
halts a child before its next model call; a two-tenant test.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] A sub-agent cannot reach a tool, skill or rung its parent version does not hold (conformance scenario, on this engine).
- [ ] A sub-agent cannot delegate (test).
- [ ] The approved hash covers every sub-agent's instructions, and changing one sub-agent's text changes it (test).
- [ ] Child steps are charged to the parent run's caps, and the kill switch halts a child before its next model call (tests).
- [ ] Every child tool call is in the ledger under the parent run, labelled with the sub-agent (integration test).

**Exit.** A customer can give their agent sub-agents, and each one can do less than its parent, never more.

#### Step 2x — Carry thinking blocks through the assistant's loop

Delivered by #4183 (#4153). The section "What it does to the assistant" above
describes the result, and the design is in
`docs/implementation-notes/2026-10-25-assistant-thinking-blocks-carried.md`.
The prompt asked for snapshots of the openrouter, local and stub providers'
request bodies. The assistant's loop has only the Anthropic provider, so the
code wins. A provider that sets no part receives exactly the history it always
did, and that is the control in their place.
