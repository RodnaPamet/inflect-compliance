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
  (Step 2a, #4148).** `@anthropic-ai/sdk@1.3.0` is in `dependencies`, exact-pinned
  and reviewed in `docs/dependency-risk-review.md`. pi-ai keeps its own nested
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
  "Powered by Claude". It runs only where the operator sets
  `AGENT_DRIVER_TOOL_RUNNER`. `runsProfiles` is true for it alone, a profile's
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
  tenant, and a name with no approved version refuses the run. A refusal settles
  the run `skill_not_mountable: …` before any model call, on this engine and on
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
| Delegation | off in v1. Later: a tool whose `run` starts a nested runner on the **same client**, with a subset of the parent's resolved tools, depth 1, the fan-out cap from `subagent-fanout-policy.ts`, and every cost charged to the parent run |
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

#### Step 2x — Carry thinking blocks through the assistant's loop

Delivered by #4183 (#4153). The section "What it does to the assistant" above
describes the result, and the design is in
`docs/implementation-notes/2026-10-25-assistant-thinking-blocks-carried.md`.
The prompt asked for snapshots of the openrouter, local and stub providers'
request bodies. The assistant's loop has only the Anthropic provider, so the
code wins. A provider that sets no part receives exactly the history it always
did, and that is the control in their place.
