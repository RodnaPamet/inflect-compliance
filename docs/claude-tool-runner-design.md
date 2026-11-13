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
- **A profile version may define inline sub-agents, run through `delegate`
  (Step 2e, #4594).** At most four, each a name, instructions, a subset of the
  version's tools and skills and a turn limit, with no description; stored
  encrypted in `AgentProfileVersion.subagentsJson`, frozen by the version
  trigger, covered by the content hash under its own domain (every existing
  version's hash unchanged), and refused by name at save and approval
  (`SUBAGENT_*`, `SUBAGENTS_WITH_FLOW`). `delegate` (`tool-runner/delegate.ts`)
  is offered to the parent only and reported as engine-supplied
  (`when-subagents-defined`). A delegation runs a child loop through the same
  loop body as the parent (`runModelLoop`), over the parent's invocation, latch,
  client, budget and both turn caps, with tools that are a filter of the
  parent's offered set under `tool-runner-subagent.<name>`. Before every model
  call in both loops the loop reads the kill switch and the breaker and charges
  one `STEPS`. Every child step carries `WorkflowStep.subagentName`, and the
  `delegate` marker closes the span the run page groups. `RUNS_SUBAGENTS` is
  true for this engine alone; any other engine refuses such a version
  `PROFILE_SUBAGENTS_NOT_RUNNABLE`.
- **A long run's earlier turns are summarised (Step 2g, #5531).** At loop-body
  step 9 of `runModelLoop`, after a complete tool round, a run whose next
  request is estimated at or above its threshold (the lowest of
  `COMPACTION_THRESHOLD_TOKENS[tier]`, 15% of its `TOKENS` limit, which is
  30,000 today, and the profile version's `compactionThresholdTokens`) sends
  Inflect's own summary call (`compactionParams`, `tool_choice: none`), after the
  kill switch, the breaker and one `STEPS`. Its tokens are charged to `TOKENS`;
  its text is egress- and injection-scanned, and any verdict but clean stops the
  run at the guard with the summary unused. It is recorded as a `MODEL_CALL`
  step with `purpose: 'compaction'` and the digests before and after, with its
  own Art 12 row. The next request is rebuilt by `tool-runner/compaction.ts`:
  the opening message verbatim, Inflect's run-state block (activated skills'
  pinned text re-hashed, refusals by code, proposals, delegations, the guard
  tally), the summary fenced as model-written, and the last turn verbatim with
  its thinking blocks dropped. Never mid tool round, not with fewer than two
  `STEPS` left, not twice in a row, and not again in a segment whose summary
  failed. A sub-agent compacts its own history on the run's one budget. A
  version may set `compactionThresholdTokens` to `0` (off) or a lower value, and
  never above the tier's constant (`COMPACTION_THRESHOLD_ABOVE_TIER`, at save and
  at approval). The SDK's `compactBeforeNextTurn()` is never used.
- **A resumed segment starts its conversation again.** The run keeps no
  transcript between segments: `lockedParams` sends the opening message alone,
  and the turn counters are per segment. So a run resumed after a guard flag,
  or after a SIGTERM moved it to `PAUSED`, starts from the opening message with
  the steps, tool calls, proposals and tokens it has already spent, and does
  not remember its earlier turns.
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
step with its own preserved-thinking checks. Step 2g's design (**Compaction**
below) keeps this helper off and adds Inflect's own summary call instead.

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
and one level deep. The points this design could not settle alone went to the
owner, who decided them on 2026-11-13 (recorded on #4594). They are listed at
the end, under **Owner decisions (2026-11-13)**, and the design below is drawn
to them. The step's code ships as two pull requests: **B**, the org-level turn
caps (below), and then **C**, the sub-agents themselves.

### What is reused from Flue, and what differs

Flue has delegated since #3473, to four specialists defined in code
(`flue/subagents/index.ts`) through the runtime's own `task` tool. The Tool
Runner reuses every piece of that work that is not Flue-shaped:

| Reused as is | Where |
| --- | --- |
| The fan-out arithmetic and the sentence the model reads | `evaluateFanOut`, `fanOutRefusalMessage` (`subagent-fanout.ts`) |
| The delegation cap's failed-read rule (unreadable is 0, owner decision 2026-11-12) | kept, and moved into the turn-cap resolver `readTurnCaps` (**Org-level turn caps** below), which replaces `readFanOutCap` (`subagent-fanout-policy.ts`) for both engines |
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

### Org-level turn caps

Owner decision 3 of 2026-11-13. Two numbers bound what one model turn may
start. An organization sets the **ceiling** of each for every workspace under
it, and a workspace may only **narrow** it:

| Cap | What it counts | Org ceiling (new) | Workspace narrowing |
| --- | --- | --- | --- |
| Delegations per turn | `delegate` calls in one turn of a Tool Runner parent; `task` operations in one turn of a Flue parent | `Organization.agentMaxSubagentsPerTurn`, `NOT NULL DEFAULT 3`, CHECK 0 to 10 | `TenantSecuritySettings.agentMaxSubagentsPerTurn`, the existing column, made nullable (`DROP NOT NULL`, `DROP DEFAULT`, the stored 3s set to `NULL` in the same migration), CHECK `NULL` or `>= 0` |
| Tool calls per turn | every `tool_use` block in one Tool Runner turn: funnel tools, `activate_skill` and `delegate` alike | `Organization.agentMaxToolCallsPerTurn`, `NOT NULL DEFAULT 1`, CHECK 1 to 10 | `TenantSecuritySettings.agentMaxToolCallsPerTurn`, new, nullable, CHECK `NULL` or 1 to 10 |

**The value that applies is `min(org ceiling, workspace value)`**, per cap. A
`NULL` workspace value, of either cap, means the workspace has not narrowed, so
the org's ceiling applies. There is no per-run delegation cap: the run's `STEPS`,
`TOKENS` and wall-clock caps bound the total, and every delegation is charged to
them. This ships as its own pull request, **B**, merged before the sub-agents
pull request, **C**.

**Storage mirrors the org switches** (#4557). The two ceilings are columns on
`Organization`, beside `agentProfilesEnabled` and `agentToolRunnerEnabled`,
`NOT NULL` with constant defaults, so the `ADD` rewrites no rows. They are
written only by a new usecase, `usecases/org-agent-turn-caps.ts`, and read only
through the resolver below. The defaults are today's behaviour, so nothing moves
when B lands: `min(3, NULL)` is 3 delegations, and `min(1, NULL)` is 1 tool
call, which is the serial request the engine sends now. Each ceiling's upper bound is
10, the top of the tool-call range, because a turn cannot start more
delegations than tool calls.

**The workspace narrowing.** The fan-out column has had no writer in the product
since #3473: every workspace holds the migration's 3. B adds both values to the
patch-shaped `PUT admin/security-settings` (`admin.manage`, the route that
already writes this row): `agentMaxSubagentsPerTurn`, 0 to 10, and
`agentMaxToolCallsPerTurn`, 1 to 10 or `null` to follow the organization. A
value above the organization's current ceiling is refused, 400
`TURN_CAP_ABOVE_ORGANIZATION_CEILING` with the ceiling in `details`, because it
would store a choice that changes nothing. Both columns
mean the same thing: `NULL` follows the organization. The fan-out column is
moved to that shape by B (the column relaxed and the stored 3s set to `NULL`
in B's migration, below). That rewrites no choice, because the column has
had no writer since #3473, so every stored 3 is the migration's default and none
is a workspace's decision. Kept `NOT NULL`, those 3s would sit under every
ceiling, and an organization raising its delegation ceiling would reach no
workspace until each one raised its own value, which is the opposite of an
org-level setting.

**One deploy, and the 3s are cleared in it.** B's migration relaxes the
column (`DROP NOT NULL`, `DROP DEFAULT`) and sets every stored 3 to `NULL` in the
same migration. That is the last moment at which every 3 is certainly the
default: B adds the column's first writer, and a later data migration could not
tell a default from a workspace that saved 3 on purpose. It needs no second
deploy, measured on main's generated client (Prisma 7.10.1): a `NULL` in its
required `Int` reads as `null` without throwing, and the column's only reader,
the previous build's `readFanOutCap`, turns that into 3, today's value. A
previous build that creates a settings row during the roll sends 3 itself, which
reads as a workspace narrowing to 3: today's value, changeable on the security
page.

**The resolver.** One function decides both caps, in two halves, as the fan-out
cap is split today:

- `src/lib/agentic/turn-caps.ts` is pure and loads in the Flue ESM graph:
  `resolveTurnCaps({ organization, workspace })` returns
  `{ delegationsPerTurn, toolCallsPerTurn }`, each with its `basis`
  (`ORGANIZATION_CEILING`, `WORKSPACE`, `NO_ORGANIZATION`, `FAILED_READ`), so a
  page can say why a number is what it is.
- `src/lib/agentic/turn-caps-policy.ts` holds `readTurnCaps(tenantId,
  requestId)`: one read of the tenant row, selecting the organization's two
  columns and the security settings' two. It never throws. **A failed read
  resolves to the narrowest safe value of both: 0 delegations and 1 tool
  call**, logged at WARN with the values applied. One query reads both, so a
  failure of either part is a failure of the read. This keeps the owner's
  decision of 2026-11-12 for delegation and adds its twin for tool calls.
  `FAILED_READ_FAN_OUT_CAP` moves here; `readFanOutCap` is removed in the same
  pull request, so there is one reader.
- A workspace with **no organization** takes the product defaults (3 and 1) as
  its ceiling, which is what it has today. An **absent** settings row narrows
  nothing.

**Who reads it.** The Tool Runner reads `readTurnCaps` once per segment, as the
design reads the fan-out cap, and hands the same values to the parent loop and
every child loop. **Flue reads the same resolver for delegations**: its driver
puts `delegationsPerTurn` into the run binding where `readFanOutCap`'s value
goes today, and `delegation-gate.ts` is unchanged. Tool calls per turn is the
Tool Runner's: Flue's runtime dispatches the model's tool calls itself and
offers no per-turn bound, so B does not apply that cap to Flue.

**On the Tool Runner, both loops.**

- `lockedParams` takes the effective tool-call cap. At 1, `tool_choice` is
  today's `{ type: 'auto', disable_parallel_tool_use: true }` byte for byte, and
  its guard pins that. Above 1, `disable_parallel_tool_use` is `false`, so the
  model may ask for several calls in one turn. **Dispatch stays serial**
  (decision 2 of 2026-10-25): the per-run queue in each tool's `run` still runs
  them one at a time, so the `TOOL_CALL` order, the cap charging and the guard
  latch stay exact.
- The count lives in the shared `run` wrapper, in a map that lives for one
  segment, keyed by the loop (parent, or the child's delegation) and its turn
  number, on the way in. The call past the cap is refused with a tool error
  naming the cap, so the model sees why ("this turn has already made 2 tool
  calls, the most allowed in one turn; continue with the
  results you have"), and is recorded as a `FAILED` `TOOL_CALL` step,
  `refused: TOOL_CALLS_PER_TURN_EXCEEDED`, with the cap in its output. It is
  charged one `STEPS`, as every recorded step is, and the funnel is never asked.
  Fan-out counts in the same map.
- A `delegate` call counts against both caps. At 1 tool call per turn the
  delegation cap binds only at 0, and the workspace and org copy says so.

**When an org lowers its ceiling below a workspace's stored value**, the lower
number applies from the next segment any run reads: a run in flight keeps the
values it read, and no turn changes cap mid-way. The workspace's stored value is
not rewritten. If the org later raises the ceiling again, the workspace's own
value applies again. The workspace's security settings show the stored value
and the value that applies, with "narrowed by your organization" when the
ceiling binds.

**The org route and the UI.** A sibling of the switches' route,
`src/app/api/org/[orgSlug]/agent-turn-caps/route.ts`: `GET` for any member who
can see the portfolio, `PUT` behind
`requireOrgPermission('canManageAgentSwitches')`, the switches' permission,
asked again in the usecase. The body is `.strict()`, `{ delegationsPerTurn?: 0
to 10, toolCallsPerTurn?: 1 to 10 }`, and at least one key. It is not folded into
the switches' route because a switch has a deployment override and these do
not: the operator's bound is `ENGINE_CAPS`. The org settings page's **Agent
features** section (`OrgAgentSwitchesSection.tsx`) gains a **Per-turn limits**
group: two `NumberStepper` inputs in `FormField`s, bounded as above, each saving
on its own and sending only its key, as each switch does. Lowering a ceiling
asks first, naming the organization and how many workspaces it reaches, as
turning a switch off does (#4850). A member without the permission sees the
values read-only. Strings go in `messages/en.json` and `messages/bg.json`.

**Audit rows.** An org change writes `ORG_AGENT_TURN_CAPS_CHANGED`, a new
`OrgAuditAction` value, with the before and after of each cap that moved and
nothing else. A `PUT` that moves nothing writes no row. It is appended after the
update commits, and a failure there is logged at ERROR and does not undo the
change, as the switches' writer behaves. A refusal is `requireOrgPermission`'s
`ORG_AUTHZ_DENIED`. A workspace change writes `AGENT_TURN_CAPS_CHANGED` with
before and after, beside `SECURITY_SETTINGS_UPDATED`, as
`API_KEY_ROTATION_AGE_CHANGED` does.

**The migration** (B, one, additive, forward-only): the enum value, added in one
deploy on the argument `20261030120000_org_agent_switches` made (only the new
usecase writes it); the two `Organization` columns with their CHECKs; and the
nullable `TenantSecuritySettings.agentMaxToolCallsPerTurn` with its CHECK; and
the fan-out column relaxed (`DROP NOT NULL`, `DROP DEFAULT`) and its stored 3s
set to `NULL`. The new columns are ones an older Prisma client never selects,
and it reads the cleared one as `null`, so no deploy split is needed (see "The
workspace narrowing").

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
| `instructions` | sanitised (`sanitizePlainText`), trimmed, non-empty, at most `PROFILE_INSTRUCTIONS_MAX_CHARS` (16,000), as the version's are |
| `toolNames` | non-empty, deduplicated, sorted, and every name one of the version's `toolNames` |
| `skillRefs` | deduplicated, sorted, and every ref one of the version's `skillRefs` |
| `maxTurns` | 1 to the version's own `maxTurns` |

A sub-agent has no description (owner decision 2): the parent chooses by name
alone, so the name is the whole of what the parent reads about a sub-agent.

At most `PROFILE_MAX_SUBAGENTS = 4` per version. The canonical form sorts the
list by `name` and writes each object's keys in the order above, so the stored
string, and therefore the hash, does not depend on the order the editor sent.

**At save**, in `prepareVersion`, after the version's own checks:

- each sub-agent's instructions go through `scanSkillText`
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
  (`SUBAGENTS_WITH_FLOW`). A version carries one or the other, never both
  (owner decision 1).

The version's own grant, skill and catalogue checks need no change: a
sub-agent's tools and skills are subsets of the version's, so a version whose
sets pass already covers its sub-agents.

**At approval**, everything above is asked again, as the version's own checks
are, because the text scan's rules can change while a version waits.

**Audit rows** (`AGENT_PROFILE_*`) gain the sub-agents' names, count and tool
names. They never carry instructions.

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

The tool's description lists the version's sub-agent names and nothing else
(owner decision 2), so no part of a child's instructions reaches the parent's
context. The list lives in the tool, so the parent's system prompt, and its
cached prefix, are unchanged for a version without sub-agents. A name outside
the enum is refused `SUBAGENT_NOT_DEFINED` without echoing it, as `activate_skill` answers `SKILL_NOT_MOUNTED`.

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
3. **Tool calls per turn**, as for every tool (**Org-level turn caps** above):
   a `delegate` past the turn's tool-call cap is refused with the cap named.
4. **The arguments**: the name in the enum, the task within its bounds.
5. **Fan-out.** The cap is the delegations value `readTurnCaps` read for the
   segment, so an unreadable row is 0, and a 0 that applies is 0.
   `evaluateFanOut` counts delegations in the parent's current turn (the
   number of the parent's yielded message), on the way in. A refusal reads
   `fanOutRefusalMessage`: at 0 it says delegation is disabled and not to
   retry, so the model carries on alone. The tool stays offered at 0, as
   `task` does on Flue, so the refusal is a ledgered step an operator can see
   rather than an absence nobody can.
6. **The task's egress scan** (`guardEgress`, source
   `tool-runner-delegate-args:<name>:<toolUseId>`), noted through the run's
   observer. Anything but clean stops the run at the guard.
7. **The kill switch and the breaker**, uncached. A kill latches the run's
   stop. An `OPEN` breaker refuses the delegation
   (`subagent_breaker_open`), as the funnel refuses every call while it is open.
8. **The child's tools**: `offerToolSet` over the parent's own invocation, with
   `profileTools` set to the sub-agent's `toolNames`, the parent's `readOnly`,
   observer and origin resolver, the sub-agent's guard source, and **the
   parent's review latch**. The engine-neutral core gains an optional `review`
   input for that, because two latches in one run is the routing-around the
   latch exists to stop. The result is then intersected by name with the
   parent's offered set, so the subset is a property of the code and not of two
   calls agreeing. Each tool lost is listed with its reason. A child left with
   no tools is refused (`subagent_has_no_tools`) and nothing is sent.
9. **The child's skills**: the parent's resolved documents and row pins,
   filtered to the sub-agent's `skillRefs`. Nothing is resolved again and
   nothing new is pinned: the run's `mountedSkills` is the version's set, and
   a child's is a subset of it. The child gets its own `activate_skill` over
   that subset. Its catalogue is measured with `catalogBytes` against
   `MAX_CATALOG_BYTES` before it is sent. That cannot fail for a subset of a
   priced set, and the check stays as the guard against a future change that
   breaks the subset.
10. **The child runner**, on the **same client** (one client per run, so
    residency is the parent's and cannot race), from `lockedParams` with a
    `subagent` option, so it is still the one function that shapes a request
    and its guard pins the child's values as well: `thread: false`, the
    `tool_choice` the run's tool-call cap gives, the parent's model tier,
    effort, thinking and fallbacks; `max_iterations` is the lower of the
    sub-agent's `maxTurns` and the run's remaining `STEPS`. The system prompt
    is Inflect's preamble with one added paragraph (you are a sub-agent named so, you work for the agent that
    delegated, you cannot delegate, answer in plain text), then the child's
    catalogue, then its instructions fenced as
    `<operator_instructions source="agent-profile-subagent" name="…">`. The one
    user message is the task, fenced and labelled as written by the delegating
    agent. The child sees the task and nothing else of the parent's
    conversation, including the run's declared input. The request's signal is
    `AbortSignal.any([parent, child])`, so every stop the parent latches aborts
    a child request in flight, which matters because the runner waits for a
    running tool and `delegate` is that tool.
11. **The child's answer**: its last message's text, scanned by
    `guardDelegateAnswer` (prefix `tool-runner`), and returned fenced as
    `<subagent_answer name="…">`.
12. **The marker step**, in `finally`, closing the span (below), and then the
    kill switch read, as after every tool call.

**The child's loop body is the parent's.** The per-message checks in
`execute.ts` (egress scan, `MODEL_CALL` step and Art 12 row, the verdict noted
before the caps, kill and operator abort, latched stops, token and wall-clock
caps, named stop reasons) move into one function both loops call, with the
sub-agent's name as a parameter. A second copy would drift, which is the
defect this repository keeps paying for. Two checks are added to that body,
so **both loops** take them (owner decision 4): each model call, the parent's
as well as a child's, charges one `STEPS` before it is sent, and the breaker is
read with the kill switch before it. Both only narrow. A parent run may
therefore halt at `STEPS` sooner than the Step 2H production evidence showed,
because its model calls are now charged beside its tool calls and activations.
That is the owner's accepted consequence.

**Where the caps bind.** The child shares the parent's `RunBudget`, its ledger
counter and its run state:

- `STEPS`: the delegation, each child model call, each child tool call and
  each child activation, and each of the parent's own model calls (decision 4);
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
`taskChars` and the tools lost at step 8; its output names the outcome
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
  name, instructions, a tool picker, a skill picker and a turn limit, and no
  description field (decision 2). The pickers offer **only what the version
  being edited has selected**, never the agent's wider grants, and the turn
  limit is bounded by the version's. Deselecting a tool or skill a sub-agent
  uses marks that sub-agent in place; the server still refuses by name, because the editor is not the
  authority.
- **The approval view** (`BehaviourTab.tsx`) shows every sub-agent of the
  submitted version: name, tools, skills, turn limit and instructions, as
  text in `<pre>`, never markup. `describeSubagentsForReview` renders the
  list in name order, and `VersionDiff` diffs it against the
  version in force, as `describeFlowForReview` does for a flow. The hash note
  says what the hash covers (`review.hashNoteWithSubagents`), and Approve sends
  the hash on screen, so the approver approves every word a run of the version
  can send.
- **The version history** shows a sub-agent count beside each version. The
  Test run is unchanged: it starts the same read-only run, which may delegate.

### Owner decisions (2026-11-13)

Decided by the owner on 2026-11-13 and recorded on #4594. The design above is
drawn to them.

1. **A version carries a flow or sub-agents, never both**
   (`SUBAGENTS_WITH_FLOW`). A later step of `docs/ai-architecture/langflow.md`
   re-points the flow's `subagent` node at one of the version's own sub-agent
   names. Reason: the node's `profileRef` names another approved profile, which
   is delegation to a different agent's text and tools, and the approver of a
   version must read all the text it runs. A node naming the version's own
   sub-agent needs a version that holds both, so how the refusal narrows for
   such a flow goes back to the owner in that step, before its code.
2. **No description.** A sub-agent has a name, instructions, tools, skills and
   `maxTurns`, and the parent chooses by name alone. Reason: nothing of a
   child's text reaches the parent's context.
3. **Both turn caps are org-level settings**, in the org settings page's
   **Agent features** section: delegations per turn (the existing fan-out cap)
   and tool calls per turn (new, default 1, range 1 to 10, calls past it refused
   visibly). The org sets the ceiling, a workspace may only narrow, and the
   value that applies is the lower of the two. There is no per-run delegation
   cap. Reason: the run's `STEPS`, `TOKENS` and wall-clock caps already bound
   the total. Designed in **Org-level turn caps**.
4. **The breaker and the `STEPS` charge before each model call apply to both
   loops**, through one shared loop body. Reason: one body with two behaviours
   is the drift the shared body exists to prevent. Both only restrict, and a
   parent run may now halt at `STEPS` sooner than Step 2H's production evidence
   showed.

## Deferral to a person

This section is the design for Step 2f (#5530), written before any code under
that step's Part 1. It carries out the owner's decision of 2026-11-13 on the
Step 4a spike (#5529): a tool call that waits for a person mid-run is built on
this engine, on a transcript Inflect stores, and not on the Agent SDK's hook.
The points that needed the owner are listed at the end, under **Owner
decisions (2f, 2026-11-13)**. The owner took every recommendation, and the
design below is drawn to them.

### What exists, and what is missing

- **A run can already park.** `AWAITING_APPROVAL` is a live status, a
  `HUMAN_CHECKPOINT` step marks where, `WorkflowRun.approvalExpiresAt` pins the
  deadline, and `resumeWorkflowRun` continues the run for a person. The static
  engine parks at a checkpoint, and a guard flag parks a reasoning run.
- **A run can already propose.** A propose tool queues a `PENDING`
  `AgentProposal` through `runProposeTool`, carrying its origin (`runId`,
  `stepSeq`), and the queue decides it: `approveAgentProposal` with the kind's
  key (`approvePermissionFor`), the signatures `resolveApprovalRequirement`
  asks for, the composer and owner exclusions, the window (`expiresAt`) and
  the `baseDigest` re-check.
- **What is missing is the continuation.** A Tool Runner segment keeps its
  conversation in memory only. Every resumed segment, after a guard flag or a
  SIGTERM, starts again from the opening message: `lockedParams` sends
  `[{ role: 'user', content: message }]`, and `TurnCallCounter`'s docstring
  says "a resumed run starts its turns afresh". So a run that proposed cannot
  be told what the person decided, and a run that resumed has forgotten what it
  did before.
- **The SDK does not fill the gap.** SDK 1.6.0 (the pinned version) has
  `deferToolCall()`, but it holds a call only until the end of the loop body,
  needs `runToolsEagerly` and streaming, and keeps nothing past the process.
  The Agent SDK's `defer` needs a stored session (the spike note, "The three
  needs"), which global rule 6 rules out at Anthropic.

### 1. Which calls can be deferred

**A deferred call is a proposal the run waits for** (owner point 1).

- Only an Inflect propose tool (the surface `runProposeTool` serves) can be
  deferred. A read is never deferred: a read's gate is the grant, and a person
  releasing a read would be a second approval path with no queue, no kind key
  and a new permission key (rule 13). An external write tool is not deferred in
  v1: its own ladder (`DISABLED`, `DRY_RUN`, `PROPOSE_ONLY`, `AUTOMATIC`)
  already decides whether a person approves it, and an approved external write
  is sent later by the dispatch pass, so the run could be told "approved and
  queued" and never the result.
- **Which propose tools defer is the profile version's choice**:
  `AgentProfileVersion.deferredToolNames`, a sorted, deduplicated subset of the
  version's `toolNames`, each one a propose tool. A call to any other propose
  tool is an ordinary proposal and the run carries on, as today. The approver
  reads the list on the approval view, so "this agent waits for a person on
  `propose_finding`" is part of what is approved.
- Each rule is a refusal by name at save and again at approval, never a silent
  drop: `DEFERRED_TOOL_NOT_IN_VERSION`, `DEFERRED_TOOL_NOT_A_PROPOSE_TOOL`,
  `DEFERRED_TOOLS_WITH_FLOW` (a flow carries its own checkpoints) and
  `SUBAGENT_TOOL_DEFERRED` (see **5. Sub-agents**).
- `RUNS_DEFERRALS`, a `Record<AgentDriver, boolean>` beside `RUNS_SUBAGENTS`,
  is true for this engine alone. Admission refuses a version with deferred
  tools on any other engine (`PROFILE_DEFERRALS_NOT_RUNNABLE`) before the run
  row exists, so a version is never run as though it had no deferrals.
- **A deferred call carries exactly one item.** A propose call can carry many
  (`proposedItemCount`). A deferred one with more than one is refused before
  the funnel with a tool error naming the rule (`DEFERRED_CALL_ONE_ITEM`),
  charged one `STEPS` and recorded as a `FAILED` `TOOL_CALL`, so the model can
  call again with one. One item means one decision on one screen, and one
  answer to the run.

**How it sits beside the existing gates.** Deferral adds a wait and grants
nothing.

- The autonomy ceiling, the policy card, the key's scopes and the grants decide
  whether the propose tool is offered at all (`offerToolSet`), exactly as for a
  propose call that does not wait. A tool the ceiling withholds is never
  offered, so it can never be deferred.
- `PROPOSE_ONLY` is a rung of the external write ladder, set on a connection.
  It is unrelated: v1 defers no external tool.
- The proposal queue is the only place the decision is taken, the rule
  `run-checkpoint-review.ts` states ("no second approval path"). The run page
  and the canvas link to the proposal; neither approves.
- A read-only run (a Test run, an `ANSWER_ONLY` version) is offered no propose
  tool, so it never defers.
- A run an A2A peer or a host consumer started keeps its clamp
  (`ctx.a2aInbound`). It may defer, because a deferral only narrows: the call
  waits for a person instead of queueing and moving on.

### 2. The deferred call, and the parked run

In order, inside the parent's serial queue (`ledgeredCall` in `tools.ts`):

1. Everything a propose call does today: the latched-stop check, `STEPS`, the
   turn cap, `TOOL_CALLS`, the wall clock, `PROPOSALS` for its one item, then
   `runGuardedTool` (the egress scan on the arguments, `runProposeTool`, the
   scans on the result) and the `TOOL_CALL` step.
2. If the funnel refused the call, or the proposal guard quarantined the item,
   nothing waits. The call returns its error as today and the run goes on. A
   quarantined proposal is never reviewed, so waiting for it would wait for
   nothing.
3. Otherwise the call latches a new stop, `{ kind: 'DEFER', proposalId,
   toolUseId }`, and the run's signal is aborted, so no further request leaves
   in this segment.
4. A later call in the same turn (possible only when the tool-calls-per-turn
   cap is above 1) is not run. Its result, sent when the run resumes, says it
   was held behind a call waiting for a person and may be made again.

**Settlement keeps today's order and puts the deferral last.** An operator's
abort, a kill, the breaker, a cap and a guard verdict all outrank it. A run
stopped by any of them in the same turn settles by that reason, and its
proposal stays in the queue as an ordinary proposal. Only a run with nothing
else latched parks.

**Parking** is one transaction in the deferral store (point 3):

- the transcript is written;
- a `HUMAN_CHECKPOINT` step is recorded `PENDING`, `label: 'deferral'`, input
  `{ deferralId, proposalId, toolCalled, toolUseId }`;
- the run moves `RUNNING` to `AWAITING_APPROVAL` conditionally (an operator's
  ABORTED stands, as in `updateRun`), with `approvalExpiresAt` set to the
  proposal's own `expiresAt`, so the wait has one clock and the runs list
  already shows it.

**No new run status** (owner point 2). `AWAITING_APPROVAL` already means "a
person must act before this run continues", every reader knows it, and
`LIVE_RUN_STATUSES` counts it. A new value would say the same thing more
narrowly, at the price of two deploys and a branch in every reader. What tells
a deferral apart from a guard flag or a static checkpoint is its row in
`WorkflowRunDeferral`, not the status.

**What holds its place** is the run's `stepCount` (the next seq) and the
deferral row. A parked run holds no worker, no process and no memory.

**The caps while parked:**

- `STEPS`, `TOOL_CALLS`, `PROPOSALS` and `TOKENS` are not touched by the wait,
  and keep accumulating across segments as they do today (`fromSeq`,
  `costTokens`, `proposedItemsSoFar`).
- **The wall clock does not run while the run waits.** `RUNTIME_MS` bounds
  unattended execution, and a wait for a person is its opposite. The deferral
  row stores `elapsedMsAtPark` (the segment's `Date.now() - runStartMs` when it
  parks), and the resumed segment starts its clock at
  `Date.now() - elapsedMsAtPark`. It must not take the worker's
  `row.startedAt`, which is what every queued segment is given today (see
  **Finding** at the end of this section).
- The tenant's concurrent-run cap counts a parked run, because it counts
  `LIVE_RUN_STATUSES`, a list with one definition shared with the replay tail.
  A tenant with many runs waiting on decisions can be refused a new run, and
  the refusal already names the cap.
- Nothing is charged to the monthly token budget while the run waits.

### 3. The transcript

**One new table, `WorkflowRunDeferral`**, one row per deferral. It is written
only by `src/lib/agentic/drivers/deferral-store.ts` (the engine's store, as
`run-store.ts` and `step-recorder.ts` are, so no engine module holds a Prisma
call) and by the decision usecase in point 4, and a single-write-seam guard
holds the two. A column on `WorkflowRun` was considered and declined:
`getWorkflowRun` and the run list read that row whole, and a transcript can be
hundreds of kilobytes.

| Column | Meaning |
| --- | --- |
| `id`, `tenantId`, `runId` | FK to the run by `[runId, tenantId]`, `onDelete: Cascade` |
| `stepSeq` | the seq of the deferred call's `TOOL_CALL` step |
| `toolUseId` | the model's `tool_use` id, whose result is left open |
| `proposalId` | the one proposal waited for; unique with `tenantId`, so it is waited for once |
| `status` | `WAITING`, `DECIDED`, `RESUMED` or `SETTLED`. TEXT with a CHECK, not a Prisma enum, and one-way by trigger |
| `decision` | `ACCEPTED`, `EDITED`, `REJECTED`, `EXPIRED` or `NOT_RESUMED`, CHECKed TEXT, set once |
| `transcriptJson` | the request the run would send next, with the deferred result left open. Encrypted |
| `transcriptHash` | hex SHA-256 of the plaintext, a separate column as `WorkflowRun.contextHash` is: encryption protects confidentiality, and the hash says the blob is the one that was written. A digest, so not encrypted |
| `model` | the model id the transcript was produced on, pinned for the resume |
| `elapsedMsAtPark` | the unattended milliseconds the run had spent when it parked |
| `parkedAt`, `decidedAt`, `resumedAt`, `settledAt` | one-way stamps |

**What the transcript holds** is exactly what the model saw and will see: the
request's `system` blocks and `tools` definitions as sent, every message of
`runner.params.messages`, the assistant reply that made the call as returned
(text, `tool_use` and `thinking` blocks with their signatures, in order, which
is the Step 2x lesson), and the user message of that turn's tool results with
the deferred call's slot open. It is byte-faithful: written with
`JSON.stringify` over the SDK's own objects and read back with `JSON.parse`,
never sanitised, never re-serialised through a schema and never trimmed.
Sanitising would change the bytes the thinking signatures bind.

**Nothing is stored at Anthropic.** Every request stays `thread: false`, and
the resume sends the whole history again, as every request of this engine
does. No new data category reaches Anthropic: the transcript is the
conversation that already went there.

**Encryption.** `src/lib/security/encrypted-fields.ts` gains
`WorkflowRunDeferral: ['transcriptJson']`. In `sanitize-rich-text-coverage` the
model goes in `NON_RICH_TEXT_MODELS`, with the reason that the column holds
exact API bytes, is never rendered, and would break thinking signatures if
sanitised. As with `PeerAgentMessage.body`, the column is never sanitised or
re-serialised. The one-way trigger on `transcriptJson` and `transcriptHash`
admits the DEK and KEK sweeps' re-wrap (ciphertext to `v2:` ciphertext, every
other column unchanged), the clear described below, and nothing else.

**Retention** (owner point 3). `docs/data-retention.md` gains a row:
**Operational**, hard-deleted by `CASCADE` from its run and the tenant, and
purged with the tenant. **DSAR-relevant: the transcript holds tool results,
which can name a person.** The transcript is cleared (set to `NULL`) when the
row moves to `RESUMED` or `SETTLED`, and `transcriptHash` stays, so what was
resumed is still provable and nothing is kept that the run no longer needs. The
record of what the run did is the step ledger and the Art 12 rows, which keep
every step.

**The tenant-table checklist** (global rule 7): the RLS triple,
`@@index([tenantId, runId])`, the unique `[tenantId, proposalId]`, a
two-tenant behavioural test registered in
`tenant-isolation-forward-lock.test.ts`, the retention row and the manifest
decision above. `app_user` holds no `DELETE` on the table.

### 4. Who decides, and how the run settles

**The decision is the proposal queue's, unchanged**: `approveAgentProposal`,
with or without edits, `rejectAgentProposal` and `bulkRejectAgentProposals`.
With them come, and the design adds nothing to:

- `assertCanWrite` and the kind's key from `approvePermissionFor`
  (`findings.create`, `risks.create`, and the rest);
- the number of distinct signatures `resolveApprovalRequirement` asks for (the
  card's rung, the risk tier and the autonomy level, the strictest wins), and
  the accountable owner's exclusion where it applies;
- the composer exclusion, the quarantine refusal, the window read against the
  clock and the `baseDigest` re-check.

No new permission key. The person who started a run may decide its deferral,
as they may decide any of its proposals today.

**The decision hook.** After a decision commits, the queue calls one function,
`settleDeferralForProposal(ctx, proposal)`, in a new usecase
`usecases/workflow-run-deferrals.ts`. It does nothing for a proposal no
deferral waits on. For one that is waited on:

- **Accepted, edited or rejected** (a decision a person took): the deferral
  moves `WAITING` to `DECIDED` with the decision; the run is claimed
  `AWAITING_APPROVAL` to `RUNNING` conditionally (the claim
  `resumeWorkflowRun` makes since #5119, so two decisions cannot resume it
  twice); the `HUMAN_CHECKPOINT` step is closed `DONE` with the decider as
  `actorUserId`; `WORKFLOW_RUN_RESUMED` is audited with
  `reason: 'DEFERRAL_DECIDED'`; and `agent-run-execute` is enqueued. A signature
  that does not yet complete the requirement is not a decision and moves
  nothing.
- **Expired**, by the `agent-proposal-expiry` sweep (00:40 UTC daily) or by
  retirement's cascade, which expires the agent's pending proposals: nobody
  decided, so the run is not continued (owner point 4). It settles `FAILED`
  with `tool_runner_deferral_expired: nobody decided the proposal this run was
  waiting for before its window closed.` (or `tool_runner_deferral_agent_retired`
  from the cascade), and the deferral is `SETTLED` with its transcript cleared.

`resumeWorkflowRun` refuses a run with a `WAITING` deferral (400,
`RUN_WAITS_ON_A_PROPOSAL`, naming the proposal id), so the generic Resume
cannot continue it without a decision. `abortWorkflowRun` works as today, and
in the same transaction settles the deferral `SETTLED` / `NOT_RESUMED` and
clears its transcript. The proposal stays in the queue.

**A kill switch, a suspension or a retirement while the run waits** settles it
at its next touch, never later than the proposal's window (owner point 4).
Retirement settles it at once, through the cascade above. A kill or a
suspension is a read at a boundary, not a write to every run, so it settles the
run when the decision arrives (step 1 below) or when the window closes,
whichever comes first.

**The resumed segment** goes through the worker (`executeQueuedWorkflowRun`,
then `executeFrom`, then this engine). `executeToolRunnerRun` asks the store
for a `DECIDED` deferral of the run before it builds an opening message. When
there is one, before anything is sent:

1. **The kill switch, the breaker and the agent's status**, as at the top of
   every segment, with `runAgentStillInService`. A run whose agent was killed,
   suspended or retired while it waited settles by that reason. The person's
   decision is already recorded on the proposal, and an approved record stands:
   a person created it with their own authority.
2. **The skill pins and the profile pin**, as every segment checks them
   (`skill_pin_drift`, `resolvePinnedRunDefinition`).
3. **The transcript's seal**: `sha256(transcriptJson)` must equal
   `transcriptHash`, or the run halts `tool_runner_deferral_transcript_unsealed`,
   as `CONTEXT_UNSEALED` halts. Nothing is repaired.
4. **The invocation is re-resolved** (`resolveMcpInvocation`) and the tools are
   offered again through `offerToolSet`, as in every segment. The request sends
   the transcript's `system` and `tools` as stored, so the prefix the thinking
   signatures bind is unchanged. Each stored tool name takes its runnable from
   the new offer. A name the new offer no longer carries gets a runnable that
   refuses (`TOOL_WITHDRAWN_DURING_WAIT`, a `FAILED` step), and a tool the new
   offer adds is not added. Authority only narrows across the wait.
5. **The deferred call's result** is written into the open slot from the
   proposal row, never from the transcript: "A person approved this proposal.
   It was created as <kind> <createdEntityId>.", the same sentence for an
   approval with changes saying so, or "A person rejected this proposal. Nothing
   was created." as an error result. The rejection's reason is not passed: it
   is a person's free text, and the model needs the fact, not the prose.
6. **The held calls' results** say they were not run.
7. **The runner starts** with the stored model, `messages` set to the stored
   messages plus that user message, and every other parameter from
   `lockedParams`, which stays the one function that shapes a request. It gains
   a `resume` option, and its guard pins that a resume sends the stored
   `system`, `tools` and `model`. The wall clock starts at
   `Date.now() - elapsedMsAtPark`. The deferral moves to `RESUMED` and its
   transcript is cleared, in the same transaction as the segment's first step.

**What "re-checked, never trusted from before the wait" means here.** The item
is checked at the call: the propose funnel's schema, the guard on the arguments
and the per-item proposal guard. At the decision the create usecase runs as
the approver, against the record as it then stands (`baseDigest`), which is
after the wait. At the resume the run's own authority is re-resolved before
anything else is sent. Nothing the run held before the wait is executed after
it on the strength of the wait. The only thing carried across is the
conversation, and the only new thing in it is the queue's decision. Owner
point 1 sets out the alternative, in which the held call itself would run
through the funnel at resume.

**The API refusing a resumed transcript** (a 400 naming a thinking block bound
to another conversation, organisation or model, for example after the
deployment's key moved to another Anthropic organisation) settles the run
`tool_runner_resume_transcript_refused`, with the API's error type. The engine
never strips thinking blocks and retries, and never sets
`prefix_mismatch_behavior: 'drop_block'`. A silent degrade is what global
rule 4 forbids.

### 5. Sub-agents

A delegation runs its child loop inside the parent's `delegate` call. Parking
there would need two transcripts, the child's and the parent's with an open
`delegate` result, and a resume that re-enters a nested loop. v1 does not do
it: a sub-agent's `toolNames` may not include a deferred tool
(`SUBAGENT_TOOL_DEFERRED`, at save and at approval), so a child's set never
carries one. The parent may defer, and a child cannot.

### 6. The ledger, Art 12 and the UI

- **Steps.** The deferred call is the usual `TOOL_CALL` step, `DONE`, output
  `{ deferred: true, proposalId }`. Parking records the `HUMAN_CHECKPOINT` step
  `PENDING`, and the decision closes it `DONE` with the decider and output
  `{ decision, proposalId }`. The resumed segment's steps follow at the next
  seq. A call refused by the one-item rule and a call to a withdrawn tool are
  `FAILED` `TOOL_CALL` steps naming their reason. No step is rewritten, and no
  model text enters the ledger.
- **Art 12.** Every model call keeps its own decision row, the resumed
  segment's included, and its digest is over the request actually sent: the
  stored history plus the result. The proposal's own decision stamps (keyed by
  the proposal's digest) apply as today. A deferral's decision does not stamp
  the run's model-call rows: the person decided one proposal, not the run.
- **Audit rows.** `WORKFLOW_RUN_DEFERRED` at parking (proposal id, tool, step
  seq), `WORKFLOW_RUN_RESUMED` with `reason: 'DEFERRAL_DECIDED'` at a decision,
  and the settlement row at expiry, retirement or abort. None carries
  transcript content.
- **The run page** shows a parked run as waiting for a decision, with the
  proposal's kind, its deadline and a link to it on `/agents/proposals`. Its
  timeline marks the checkpoint as deferred to a person and, once decided, who
  decided and when.
- **The proposals page** marks a proposal a run is waiting on, linking to the
  run, so the reviewer knows the decision continues work.
- **The runs list** offers "Open proposal" in place of Resume.
- **The Behaviour editor** gains a "Wait for a person" picker over the
  version's selected propose tools, and the approval view lists the deferred
  tools.
- Strings go in `messages/en.json` and `messages/bg.json`.

### 7. The migration and the deploys

One migration, additive and forward-only:

1. `WorkflowRunDeferral`, with its CHECKs, indexes, FK, RLS triple, grants and
   its one-way trigger.
2. `AgentProfileVersion.deferredToolNames TEXT[] NOT NULL DEFAULT '{}'`, and
   `CREATE OR REPLACE FUNCTION agent_profile_version_lifecycle()` freezing it
   with the rest of the version, in the same migration, as Step 2e did for
   `subagentsJson`. Tool names are not secret, so the column needs no manifest
   entry.

**No enum value is added, so the enum rule does not bind. It still ships in
two deploys**, because every reader must know what a parked row means before
any row exists:

- **Deploy 1, the readers**: the table and the column; `resumeWorkflowRun`'s
  refusal; `abortWorkflowRun`'s settlement; the decision hook; the resume
  branch in `executeToolRunnerRun`; the worker's clock from `elapsedMsAtPark`;
  the run page and the proposals page. Nothing can write a deferral yet,
  because the save and approval schemas still refuse `deferredToolNames`.
- **Deploy 2, the writer**: the editor, the save and approval checks,
  `RUNS_DEFERRALS['tool-runner'] = true`, and the parking path. During its
  roll, an older container meets a parked run only through code deploy 1
  taught, and rolling deploy 2 back leaves parked runs that deploy 1 still
  resumes or settles.

**Change class:** Significant, for the new table holding an encrypted
transcript and the security-relevant resume path.

### Owner decisions (2f, 2026-11-13)

The owner took the recommendation on every point. The options are kept as
written, so the reasons stay beside the choice.

1. **Which calls can be deferred.**
   (a) Inflect propose tools the version names, decided in the existing
   proposal queue, the run resuming with the decision. (b) Any tool, reads and
   external writes included, through a new "release" approval in which the held
   call runs through the funnel at resume as the agent. That needs a new
   approval surface and a new permission key, and for a propose tool it means
   two approvals, the release and then the proposal. (c) As (a), but every
   propose call of a version that opts in, with no per-tool list.
   **Decided (owner, 2026-11-13): (a).** It reuses the queue's four-eyes, kind keys,
   window and staleness check, and adds no second approval path.
2. **The parked run's status.** (a) Reuse `AWAITING_APPROVAL`, told apart by
   the deferral row. (b) A new `WorkflowRunStatus` value. **Decided (owner, 2026-11-13):
   (a).** Every reader already handles it, and (b) costs two deploys and a
   branch in every reader for a distinction the row already makes.
3. **How long the transcript is kept.** (a) Cleared when the run resumes or
   settles, keeping its hash. (b) Kept with the run, Operational, until the run
   is deleted. (c) Retained as a regulatory artefact that survives the tenant
   purge. **Decided (owner, 2026-11-13): (a).** The ledger and the Art 12 rows are the
   record; the transcript is working state holding tenant data, and the hash
   still proves what was resumed.
4. **An expired wait, and a kill while waiting.** (a) An expiry settles the
   run `FAILED`; a kill or suspension settles it at the decision or the
   window's end, whichever comes first. (b) An expiry resumes the run with an
   "expired" result, so the model can finish its answer without the write.
   (c) As (a), and engaging a kill switch also settles that agent's parked runs
   at once. **Decided (owner, 2026-11-13): (a).** Nobody decided, so nothing should continue
   unattended days later, and (c) would make the kill switch write to runs,
   which it has never done.
5. **The same transcript for the other resumes.** Today a guard flag's resume
   and a SIGTERM's restart the conversation (see **What exists**). (a) 2f
   stores a transcript for deferrals only, and the other resumes are a
   separate issue. (b) 2f also stores one when a guard flag parks the run.
   (c) The run stores its transcript after every turn, so a SIGTERM resume
   continues too, at the cost of one encrypted write per turn.
   **Decided (owner, 2026-11-13): (a)**, and the restart is recorded in Current state now.

### Finding: a reasoning run resumed by a person is charged its wait

`resumeWorkflowRun` re-bases the wall clock for the inline static path only,
and its comment says the queued path is "a SIGTERM retry of a RUNNING row".
But a person's resume of a reasoning run (Flue or this engine, after a guard
flag) is enqueued to `agent-run-execute`, and `executeQueuedWorkflowRun`
passes `row.startedAt.getTime()`. So a flagged run approved more than
`ENGINE_CAPS.WALL_CLOCK_MS` (one hour) after it started halts at `RUNTIME_MS`
as soon as it resumes: the defect `approval-window.ts` describes, on the path
its fix did not reach. Step 2f does not inherit it (its clock comes from `elapsedMsAtPark`),
and the existing path needs its own fix: #5534.

## Compaction

This section is the design for Step 2g (#5531), written before any code under
that step's Part 1. It carries out the owner's decision of 2026-11-13 on the
Step 4a spike (#5529): context compaction for long runs is built on this
engine, not by adopting the Agent SDK. The points that need the owner are
listed at the end, under **Owner decisions (2g, 2026-11-13)**; the owner took
every recommendation. The first of them comes before everything else, because
the caps change what compaction is for.

### What the caps already decide

- `ENGINE_CAPS.MAX_TOKENS` is 200,000 per run, and no policy card can raise it
  (`resolveRunCaps` takes the engine's value for `TOKENS`). The engine charges
  `TOKENS` with every call's whole input, cache reads and writes included
  (`tokensOf` in `execute.ts`), plus its output.
- Both models the engine uses, Sonnet 5.5 and Opus 5.5, have a 1M-token
  context window.
- So a run's last request can never be larger than the run's total charge,
  and the total stops at 200,000. **No Tool Runner run can reach the context
  window under today's caps.** A long run stops at `TOKENS`, or at `STEPS`
  (50, every model call included), first, and
  `tool_runner_context_exhausted` cannot be reached. The production Test run
  spent 25,119 tokens on three model calls.

What compaction can do on this engine today is make each later call smaller,
so the same `TOKENS` budget pays for more turns. A rough measure: a run whose
context starts near 8,000 tokens and grows by 4,000 a turn has spent about
200,000 tokens by its ninth call, when its context is near 40,000 tokens. A
threshold has to sit well below that to fire at all, and each compaction costs
a summary call. That is owner point 1. The design below is correct whichever
way it is decided: it computes the threshold from the run's own `TOKENS` limit,
so it moves if the cap moves.

### 1. When it triggers

- **Where.** In `runModelLoop`, at loop-body step 9, after the turn's tools
  have run (`runner.generateToolResponse()`) and before the kill switch, the
  breaker and the `STEPS` charge that precede the next call. Never mid tool
  round, and never on a reply that does not ask for another call.
- **The measure** is an estimate of the next request: the reply's input tokens
  (cache reads and writes included), its output tokens, and the turn's tool
  results at `estimateTokens` (four characters a token). It is an estimate on
  purpose: the exact count would need a `count_tokens` call per turn, which is
  another request to Anthropic for a number this rule does not need exactly.
- **The threshold** is the lowest of three values:
  - `COMPACTION_THRESHOLD_TOKENS[tier]`: 150,000 for both tiers, the API's own
    default trigger, which binds only if `TOKENS` is raised;
  - `COMPACTION_BUDGET_SHARE` (0.15) of the run's `TOKENS` limit, which is
    30,000 under the engine's cap;
  - the profile version's own value, when it has lowered it.
  All three constants live in `params.ts` beside `MAX_TOKENS_PER_TIER`, and its
  guard pins them.
- **A profile may turn compaction off or lower its threshold, and never raise
  it** (owner point 2): `AgentProfileVersion.compactionThresholdTokens`,
  nullable `INT`. `NULL` takes the engine's threshold, `0` turns compaction off,
  and any other value is 10,000 to 150,000 (a CHECK). A value above the tier's
  constant is refused at save and at approval
  (`COMPACTION_THRESHOLD_ABOVE_TIER`). The approval view shows it, so an
  approver knows whether a run of the version may summarise its own history.
- **It does not trigger** when fewer than two `STEPS` remain (the summary and
  at least one call after it), when a stop is latched, when a deferral is
  latched (the run parks with its history as it stands, see **Deferral to a
  person**), or right after a compaction. If the compacted request is still
  over the threshold, the run carries on and `TOKENS` decides. A summary that
  fails (below) turns compaction off for the rest of the segment, so a model
  that will not summarise is not asked again every turn.

### 2. What a summary is

**Inflect's own summary call, not the SDK's helper** (owner point 3). The SDK's
`compactBeforeNextTurn()` stays off, as the locked-parameters table says.

The summary request is shaped by `compactionParams()` in `params.ts`, so that
file stays the one place a request is shaped and its guard pins the values:

- the same `system`, `tools`, `model`, `thinking`, `output_config`,
  `fallbacks`, `thread: false` and `stream: false` as the run's own requests.
  Unchanged `system` and `tools` keep the cached prefix, and keep the history's
  thinking blocks valid: leaving the tools out of one request would invalidate
  every thinking block the API checks after it;
- `tool_choice: { type: 'none' }`, so no tool can be called. A tool choice is
  not part of the prefix the thinking signatures bind;
- `messages`: the current history unchanged, plus one appended user message
  holding Inflect's fixed instruction (`COMPACTION_INSTRUCTION`): what to keep
  (what the run has found, the record ids it read, what is still open, and the
  next step it meant to take), that Inflect lists refusals, proposals and
  skills separately so they need not be repeated, and a closing sentence,
  "Write the summary as plain text. Do not call a tool.";
- `max_tokens`: `COMPACTION_SUMMARY_MAX_TOKENS`, 4,000.

**Its accounting is a model call's:**

- before it is sent, `stoppedBeforeModelCall`: the kill switch, the breaker and
  one `STEPS`, as before every model call in both loops;
- its usage is added to `costTokens` and charged to `TOKENS`, and the token
  and wall-clock caps are read after it, as after every reply;
- its text gets the egress scan (`<prefix>-compaction-output:<runId>:<n>`) and
  the injection scan (`guardUntrustedInput`,
  `<prefix>-compaction-summary:<runId>:<n>`), where the prefix is
  `tool-runner` or the sub-agent's source. The injection scan is there because
  the summary is written from tool results and goes back into the model's
  context. Any verdict but CLEAN is noted as a model-output verdict is, the
  run stops at the guard, and the summary is never used;
- it is recorded as a `MODEL_CALL` step (labelled with the sub-agent in a
  child), with input `purpose: 'compaction'`, `decisionDigest` over the summary
  request, `compactedFromDigest` (the digest of the last request sent with the
  full history), `summaryDigest` (SHA-256 of the summary text),
  `messagesSummarised` and `estimatedTokensBefore`, and output
  `{ compactedToDigest }`, the digest of the rebuilt history. No
  `WorkflowStepKind` value is added: `purpose` tells the step apart, and a new
  enum value would cost two deploys and a branch in every reader;
- it has its own Art 12 row, as every model call does, whose output summary is
  the summary text only when both scans were clean.

**A summary that fails** (a `refusal`, `max_tokens`, no text, or a fallback
model's refusal) is discarded. Its step is recorded `FAILED` with the stop
reason, the run carries on with its history uncompacted, and compaction is off
for the rest of the segment.

### 3. What survives

The request after a compaction is built by code, in a new
`tool-runner/compaction.ts`, and never by the model. In order:

1. **`system`, unchanged**: the preamble, the skill catalogue and the
   operator's instructions, fenced. They were never in `messages`, so a summary
   cannot touch them, and the version's content hash and the run's
   `profileInstructionsHash` describe them exactly as before.
2. **`tools`, unchanged.**
3. **The opening user message, verbatim**: the run's declared input, fenced as
   `agent.run-input`, as `runMessage` built it. In a child, the delegated task,
   fenced as the delegating agent's.
4. **Inflect's run-state block**, one user message fenced
   `<run_state source="inflect">`, built from the run's own state:
   - **activated skills**: for each skill the loop activated, its pinned
     instructions, re-hashed against the row's pin and fenced exactly as
     `activate_skill` returns them. A mismatch stops the run
     (`SKILL_PIN_MISMATCH`). A summary never paraphrases a skill;
   - **refusals**: each `FAILED` tool call of the loop so far, by tool name and
     refusal code, never content;
   - **proposals**: each proposal the run made, by id, kind and status, read
     through `drivers/run-store.ts` with a bound. A summary can never drop a
     pending proposal, because it is not the summary that carries it;
   - **delegations** (the parent only): each sub-agent's name and outcome;
   - **verdicts**: the guard's tally. By construction every verdict is CLEAN,
     because any other has already stopped the run, and the block says so.
5. **The summary**, fenced `<run_summary source="model">`, with a line saying
   the model wrote it from the earlier turns and that it is data, not
   instructions.
6. **The last turn, verbatim**: the assistant message's text and `tool_use`
   blocks, and the user message with that turn's tool results exactly as the
   runner produced them, so the pending results reach the model unsummarised.
   The assistant message's `thinking` blocks are removed: the API refuses a
   retained turn's thinking once the history before it has changed, and a
   compaction is such a change. Removing them is the documented compatible
   form; editing them is not.

**The review latch and the verdicts** are never in the conversation. The latch
is one object per run, held by the run, and a compaction neither reads nor
resets it. A compaction never runs with it tripped, because a tripped latch is
a latched stop.

The runner continues on the rebuilt history through `setMessagesParams`. The
cached prefix (`tools` and `system`) survives, and the messages after it are
written to the cache once.

### 4. Audit, and resume

- **The ledger keeps every original step.** A compaction adds one
  `MODEL_CALL` step, and deletes and rewrites nothing. Compaction changes what
  the model sees, never what is recorded.
- **Art 12 stays complete.** Every later model call's row is digested over the
  compacted request it actually sent, and the compaction step names the
  digests before and after, so a reviewer can follow which history each call
  saw. Model text never enters the ledger: the summary reaches only the
  decision row's bounded, sanitised summary, and a deferral's transcript while
  that exists.
- **Resume.** The issue asks that `executeFrom` rebuild the same compacted
  state. On this engine a resumed segment keeps no conversation: it starts
  again from the opening message (see **Deferral to a person**, "What exists,
  and what is missing"). So a guard flag's or a SIGTERM's resume has no
  compacted state to rebuild, and the design does not invent one. The one
  resume that continues a conversation is a deferral's, and it continues from
  the stored transcript, which holds the compacted messages exactly as sent:
  byte-faithful, not re-derived. Everything in the run-state block is
  deterministic given the ledger and the pins (ordered by seq), so a test
  rebuilds the block from a fixture ledger and compares bytes. The summary is
  the one part a model wrote, and it is stored, never generated again.

### 5. Sub-agents

Compaction lives in `runModelLoop`, so it applies to both loops: one body with
one behaviour, as owner decision 4 of 2026-11-13 requires. A child compacts its
own messages, independently of its parent. Its opening message is its task,
its run-state block lists its own activations and refusals, and its summary
call is charged to the run's one budget and labelled with the sub-agent's name.
A child's compaction never touches the parent's history, which receives only
the child's answer. A child starts from its task alone and is bounded by its
`maxTurns`, so it reaches the threshold rarely, and it takes the same
threshold as its parent.

### 6. The migration, the sub-processor and the UI

- **One column**, `AgentProfileVersion.compactionThresholdTokens INT NULL`,
  with its CHECK, and `CREATE OR REPLACE FUNCTION
  agent_profile_version_lifecycle()` freezing it, in the same migration. A
  number, so no manifest entry. **One deploy**: an older client never selects
  the column, and an older worker running a version that sets it does not
  compact, which is today's behaviour.
- **No new data category reaches Anthropic.** The summary request carries the
  history that already went there, and the `compact-2026-09-04` beta is not
  used, so no new Anthropic feature's retention terms apply. The pull request
  says so and quotes the Anthropic row of `docs/sub-processors.md`.
- **The run page** labels a compaction step "Conversation summarised", with
  the estimated tokens before and the request size after. **The Behaviour
  editor** gains "Summarise long conversations": the default, off, or a lower
  threshold in a `NumberStepper` bounded by the tier. The approval view shows
  it. Strings go in `messages/en.json` and `messages/bg.json`.
- **Change class:** Significant, because the design adds a column (the issue's
  own rule).

### Owner decisions (2g, 2026-11-13)

The owner took the recommendation on every point. The options are kept as
written, so the reasons stay beside the choice.

1. **What compaction is for, under today's caps.** (a) Build it as a
   token-budget measure, with the threshold at 15% of the run's `TOKENS` limit
   (30,000 today), and decide the cap separately. (b) First change how
   `TOKENS` is counted or bounded (for example, cache reads at their billed
   weight, or a larger engine cap for profile runs), so that a run can grow
   towards the context window, and then build compaction for that. Raising a
   cap is a widening, so it is the owner's alone. (c) Hold 2g until a profile
   is seen to stop at `TOKENS`. **Decided (owner, 2026-11-13): (a)**, recording that it buys
   a few turns per run today, and taking (b) as its own decision: the threshold
   rule is right under either answer.
2. **A profile's control.** (a) A column on the version: off, or a lower
   threshold, never higher. (b) No control in v1: the engine's threshold for
   every profile, and no column, which keeps 2g Standard. **Decided (owner, 2026-11-13):
   (a).** Turning it off is the safe direction for a profile whose answer needs
   its whole history, and the approver should see it.
3. **The mechanism.** (a) Inflect's own summary call and rebuild, as above.
   (b) The SDK's `compactBeforeNextTurn()` with the `compact-2026-09-04` beta:
   the server summarises the whole of `messages`, the last turn's tool results
   and the activated skills' text included, and returns an opaque
   `encrypted_content` the model reads and Inflect cannot. Its retention terms
   were not found. **Decided (owner, 2026-11-13): (a).** What survives is decided by code
   Inflect can test, the pending results reach the model unsummarised, and
   nothing new is asked of the sub-processor.

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
| 2f | Defer a tool call to a person mid-run | 2e | Significant — new tenant table holding an encrypted transcript, schema migration |
| 2g | Context compaction for long runs | 2e | Significant — schema migration (one column) |
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

**Part 1 is done**: the **Delegation** section above, with the owner's
decisions of 2026-11-13. Part 2 ships as two pull requests, B (the org-level
turn caps, including tool calls per turn) and then C (the sub-agents). Where the
prompt above asks for the breaker and the `STEPS` charge before each child model
call, decision 4 applies both to the parent's loop as well.

**Hardening**

- [ ] The value that applies for each turn cap is the lower of the org's ceiling and the workspace's, a failed read is 0 delegations and 1 tool call, and a tool call past the cap is refused with a tool error naming it (tests, B).
- [ ] A sub-agent cannot reach a tool, skill or rung its parent version does not hold (conformance scenario, on this engine).
- [ ] A sub-agent cannot delegate (test).
- [ ] The approved hash covers every sub-agent's instructions, and changing one sub-agent's text changes it (test).
- [ ] Child steps are charged to the parent run's caps, and the kill switch halts a child before its next model call (tests).
- [ ] Every child tool call is in the ledger under the parent run, labelled with the sub-agent (integration test).

**Exit.** A customer can give their agent sub-agents, and each one can do less than its parent, never more.

#### Step 2f — Defer a tool call to a person mid-run

**Goal.** A profile version can name propose tools whose calls wait for a
person. The run parks on Inflect's own encrypted transcript, the person
decides in the proposal queue, and the run continues with the decision. This is
need (1) of the Phase 4 trigger, which the owner placed on this engine on
2026-11-13 (#5529).

```text
You are implementing Step 2f of the roadmap in docs/claude-tool-runner-design.md.
Read the global rules and definition of done in the Roadmap of
docs/claude-agent-sdk-design.md, and this document's Current state and its
section "Deferral to a person", including its "Owner decisions (2f,
2026-11-13)". Read src/lib/agentic/tool-runner/
(execute.ts, tools.ts, params.ts, delegate.ts), src/lib/agentic/drivers/,
src/app-layer/usecases/workflow-runs.ts (resumeWorkflowRun, abortWorkflowRun,
executeQueuedWorkflowRun) and src/app-layer/usecases/agent-proposals.ts.
Step 2e is merged.

Part 1 is done: the design section above. If a step below would have to
deviate from it, stop and ask.

Goal: a deferred call parks the run and a person's decision continues it.

1. Deploy 1 (readers). One migration: WorkflowRunDeferral with its RLS triple,
   CHECKs, one-way trigger (admitting the key-rotation re-wrap and the clear),
   no app_user DELETE; AgentProfileVersion.deferredToolNames and the replaced
   lifecycle function. The manifest entry, the retention row and the
   sanitize-coverage classification. resumeWorkflowRun refuses a run with a
   WAITING deferral; abortWorkflowRun settles it; settleDeferralForProposal is
   called after every queue decision and by the expiry sweep and the
   retirement cascade; the resume branch in executeToolRunnerRun, with the
   wall clock from elapsedMsAtPark. The run page and the proposals page.
2. Deploy 2 (the writer). deferredToolNames in the save and approval schemas
   with every refusal named in the design; RUNS_DEFERRALS; the DEFER stop and
   the parking transaction in the engine; the one-item rule; the Behaviour
   editor and the approval view.
3. lockedParams gains the resume option, and its guard pins that a resume
   sends the stored system, tools and model.

Tests: a deferred call parks the run and no request leaves after it; an
approval resumes it with the created id and a rejection with an error result,
both through the queue's own usecases; a second decision cannot resume twice;
an expiry and a retirement settle it; a kill engaged while it waits settles it
at the decision; a tool withdrawn during the wait is refused at resume and a
tool granted during it is not offered; a tampered transcript halts the run; the
resumed request's system, tools and earlier messages are byte-identical to the
parked one; the wall clock does not count the wait; a two-tenant test.

Deliver per the Definition of done. This step is Significant.
```

**Hardening**

- [ ] A deferred call parks the run with no request sent after it, and a person's decision in the proposal queue is the only way it continues (integration test).
- [ ] The resumed request's `system`, `tools` and earlier messages, thinking blocks included, are byte-identical to the transcript, and the stored transcript is encrypted at rest (test reads the raw column).
- [ ] Authority only narrows across the wait: a withdrawn tool is refused at resume, and a newly granted one is not offered (tests).
- [ ] An expired proposal, a retirement and a kill switch each settle a parked run with a named reason, and an abort settles its deferral (tests).
- [ ] The wall clock does not count the wait, and the other caps keep accumulating across it (tests).
- [ ] A sub-agent cannot name a deferred tool, and an engine whose `RUNS_DEFERRALS` entry is false refuses such a version before the run row exists (tests).
- [ ] The two-tenant test, the RLS coverage and the single-write-seam guard pass for `WorkflowRunDeferral`; mutation: removing the conditional claim lets two decisions resume one run.

**Exit.** An agent can ask a person mid-run and carry on with the answer, and
nothing it held before the wait runs on the strength of the wait.

#### Step 2g — Context compaction for long runs

**Goal.** A run whose next request would cross the compaction threshold has its
earlier turns summarised by Inflect's own model call, with the instructions,
the skills, the pending results, the refusals and the proposals kept outside
the summary. This is need (2) of the Phase 4 trigger, which the owner placed on
this engine on 2026-11-13 (#5529).

```text
You are implementing Step 2g of the roadmap in docs/claude-tool-runner-design.md.
Read the global rules and definition of done in the Roadmap of
docs/claude-agent-sdk-design.md, and this document's Current state and its
section "Compaction", including its "Owner decisions (2g,
2026-11-13)". Read src/lib/agentic/tool-runner/ (execute.ts,
params.ts, skills.ts, delegate.ts) and src/lib/agentic/run-caps.ts.
Step 2e is merged.

Part 1 is done: the design section above. If a step below would have to
deviate from it, stop and ask.

Goal: compaction inside runModelLoop, for the parent and every sub-agent.

1. params.ts: COMPACTION_THRESHOLD_TOKENS, COMPACTION_BUDGET_SHARE,
   COMPACTION_SUMMARY_MAX_TOKENS, COMPACTION_INSTRUCTION and
   compactionParams(), pinned by the locked-params guard.
2. tool-runner/compaction.ts: the trigger, the run-state block and the rebuilt
   history, as the design orders them.
3. The summary call in the loop body at step 9: stoppedBeforeModelCall first,
   the egress and injection scans, the MODEL_CALL step with
   purpose: 'compaction' and its digests, the Art 12 row, a failure turning
   compaction off for the segment.
4. AgentProfileVersion.compactionThresholdTokens, its CHECK, the replaced
   lifecycle function, the save and approval refusal above the tier, the
   Behaviour editor control and the approval view.
5. The run page's label for a compaction step.

Tests: compaction fires at the threshold and not below it, and not with fewer
than two steps left; the opening message, the activated skills' text, the
refusals, the proposals and the last turn's tool results are byte-identical
after it; the last turn's thinking blocks are removed and no other block is
edited; a flagged summary stops the run at the guard and is never used; the
summary call is charged a step and its tokens; a child compacts without
touching its parent's history; the run-state block rebuilt from a fixture
ledger is byte-identical; the ledger keeps every original step.

Deliver per the Definition of done. This step is Significant (a column).
```

**Hardening**

- [ ] Nothing a run must keep is ever summarised: the instructions, the opening message, the activated skills, the refusals, the proposals and the pending results reach the model verbatim after a compaction (test, with a mutation that moves one into the summary).
- [ ] The summary call is charged one `STEPS` and its tokens, and asks the kill switch and the breaker first (tests).
- [ ] The summary is egress- and injection-scanned, and a flagged one is never used (test).
- [ ] A profile can turn compaction off or lower its threshold and never raise it (save and approval tests).
- [ ] Every original step stays in the ledger, and the compaction step names the digests before and after (integration test).
- [ ] A sub-agent compacts independently and charges the run's one budget (test).

**Exit.** A long run keeps what it must keep, and the record of it is
unchanged.

#### Step 2x — Carry thinking blocks through the assistant's loop

Delivered by #4183 (#4153). The section "What it does to the assistant" above
describes the result, and the design is in
`docs/implementation-notes/2026-10-25-assistant-thinking-blocks-carried.md`.
The prompt asked for snapshots of the openrouter, local and stub providers'
request bodies. The assistant's loop has only the Anthropic provider, so the
code wins. A provider that sets no part receives exactly the history it always
did, and that is the control in their place.
