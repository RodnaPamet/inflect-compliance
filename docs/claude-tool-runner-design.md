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

- **The SDK is present only as a transitive, pinned dependency.**
  `@anthropic-ai/sdk@0.129.0` arrives through `@earendil-works/pi-ai@1.4.0`,
  Flue's model layer (`package-lock.json`; `docs/dependency-risk-review.md`).
  Inflect's own Anthropic callers use raw `fetch`
  (`src/app-layer/ai/*/anthropic-provider.ts`). SDK 1.0.0 (API version
  `2026-10-21`, a breaking release) shipped on 2026-10-21; 1.3.0 is current.
- **The assistant owns a hand-written loop.** `tool-loop.ts` with
  `turn-provider.ts` runs the same loop against anthropic, openrouter, local and
  stub providers. It dispatches tool calls one at a time and checks the guard
  latch after each, bounds iterations, total tool calls and wall clock, and
  states its halts in the answer. Its message builder drops `thinking` blocks
  between turns.
- **The run engines are `static` and `flue`**, behind the driver seam described
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
| Advertised set | `offerTools` output, the engine-neutral core shared with Flue |
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
  records both. Step 1 checks whether 1.x still ships a `require` condition. If
  it does, the dynamic-import boundary Flue needs (`flue/driver.ts`) is not
  needed here.
- `AGENT_DRIVERS` gains `'tool-runner'`, with the env switch
  `AGENT_DRIVER_TOOL_RUNNER` (opt-in, read like `AGENT_DRIVER_FLUE`) and a
  `DRIVER_IMPLEMENTED` entry. `AgentDriverMode` gains `TOOL_RUNNER` in two
  deploys.
- `src/lib/agentic/tool-runner/` holds `driver.ts`, `execute.ts`,
  `params.ts`, `client.ts` and `tools.ts`, over the engine-neutral tool core
  from shared step 1.
- `docs/sub-processors.md`: the Anthropic row's agent-run purpose names this
  engine and the "tenant-authored agent instructions" category, the same entry
  the Agent SDK design adds.

### What it does to the assistant

Nothing, by recommendation. The assistant's loop is provider-neutral, and the
owner chose that in #3808. One observation from this research belongs to its
own issue: `tool-loop.ts`'s message builder drops `thinking` blocks between
turns. On Opus 5.5 those carry the model's reasoning and its progress notes
between tool calls. Passing them back unchanged is what the API expects, and
the API drops, unbilled, any block a model cannot read.

## Decisions for the owner

1. **Make this the builder's first engine.** Recommended, in place of the Agent
   SDK, for the reasons in the table at the top. The Agent SDK design's step 0
   becomes a confirmation spike, not an open choice.
2. **Serial tool dispatch in v1.** `disable_parallel_tool_use` costs extra turns
   on fan-out-heavy work. A per-run mutex inside `run` keeps the ledger exact
   and allows parallel requests, at the price of a lock to get right. v1 takes
   the simpler shape.
3. **A direct SDK dependency.** It adds one package the repo already carries
   transitively. The alternative, extending the raw-`fetch` provider pattern
   into a full agent loop, is #3808's choice for the assistant. It does not
   carry over: an engine for customer-built agents gains a lot from the SDK's
   handling of `pause_turn`, refusal fallbacks and thinking blocks.
4. **`LOCAL_ONLY` tenants.** Proposed: refused on this engine with a named
   reason, and served by Flue. An Anthropic-compatible local gateway would lift
   the refusal without a code change.

## Roadmap (future direction)

Shared steps 1–4 are defined in `docs/claude-agent-sdk-design.md` (engine-neutral
tool core and conformance suite, agent profile, builder UI, engine settings
page). This engine's own steps:

1. **Dependency and client.** Add `@anthropic-ai/sdk` 1.x; `clientForRun` with
   the workspace header; a guard that no other module constructs an Anthropic
   client for agent runs.
2. **The driver.** Two-deploy `TOOL_RUNNER` enum; env switch; `tool-runner/`
   execute loop; `lockedParams` and its guard. The conformance suite must be
   green on the faux client before `DRIVER_IMPLEMENTED` flips.
3. **Skills on this engine.** The `activate_skill` tool over the existing mount
   gate and hash pins.
4. **Delegation.** The nested-runner tool, bounded by the existing fan-out policy,
   after the owner reopens the depth-1 decision for this engine.
5. **Assistant follow-up, separate issue.** Carry `thinking` blocks through
   `tool-loop.ts` turns.
