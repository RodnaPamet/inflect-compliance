# 2026-09-20 — Flue 2.1.0: what the API actually offers the driver seam

**Commit:** `<sha>` feat(agentic): run provenance on proposals + MODEL_CALL/TOOL_CALL step kinds (1/3)

The integration plan for running this product's agents on an external agent
runtime was written against **Flue 1.0-beta**. Before building the seam, the
published API was read. This note records what is there, because two of the
plan's five points turned out to rest on calls that do not exist.

## The premise had moved

| plan says | actually |
|---|---|
| version `1.0-beta` | **2.1.0** — 76 releases, Apache-2.0, `withastro/flue` |
| package `@withastro/flue` | 404 |
| package `@flue/core` | 404 |
| — | the real packages are **`@flue/runtime`** (framework) and `@flue/sdk` (remote client) |

The plan's risk section argues from the beta: *"traction is not maturity;
pre-1.0 means breaking changes."* **That argument no longer holds at 2.1.0** —
and it is worth saying plainly rather than quietly dropping, because the
conclusion it supported (build a driver seam rather than adopt directly) is
still right for a different reason: the seam is what lets the register, the
policy card and the kill switch stay in front of an agent we did not write.

A pre-1.0 risk does turn up later in this note. It is not on Flue.

## Point by point

`@flue/runtime@2.1.0`, `engines: node >=22.19.0` (this repo is `>=24 <25`).

| plan point | seam | verdict |
|---|---|---|
| 1 — driver bound to the register | our own code | no API dependency |
| 2 — MCP registry into `useTool` | `useTool`, main entry | **stronger than assumed** |
| 3 — propose-not-commit is the only write path | our own tool handlers | no API dependency |
| 4 — guard sandwich around every model call | **not on the public API** | see below |
| 5 — `WorkflowRun` stays the system of record | our schema | with one caveat |

### Point 2 is better than the plan assumed

```ts
useTool({ name, description, input?, output?, harness?, durable?,
          timeoutMs?, annotations?: McpToolAnnotations, run })
```

`annotations` is documented as *"from an adapted MCP tool or mirroring one in a
wrapper. The runtime ignores the field; application code reads the hints to gate
calls."* Adapting an MCP tool and gating on its hints is not a workaround here —
it is the field's stated purpose. `useMcpConnection` / `defineMcpConnection`
exist alongside it.

### Point 4 has no public seam, and this is the finding

The plan treats the AI-Guard sandwich as *"the product, not the plumbing"* and
as a prerequisite rather than a nice-to-have. The public API cannot carry it:

```ts
useModel(model: string, options?: { thinkingLevel?, compaction? })
useResponseStart(run: ResponseMetadataCallback<{ metadata, log }>)
useResponseFinish(run: ResponseMetadataCallback<{
    metadata, response: { usage: PromptUsage, toolCalls }, log }>)
```

The callback type is named `ResponseMetadataCallback` and it is accurate. **No
prompt. No model output text.** `usage` is documented as *"the response's
aggregate usage across all turns and re-attempts"*, so it is not per-call
either. Nothing on the main entry can run `guardUntrustedInput` over an
assembled prompt or `guardEgress` over a model's output.

A seam does exist one layer down. `@flue/runtime/internal` — a declared export
in the package's `exports` map, not an undocumented dist file — exports
`setProvider`, `hasProvider`, `resolveModel` and `registerBuiltinProviderModule`.
In the underlying `@earendil-works/pi-ai`, **"Providers own stream behavior"**:

```ts
stream<T>(model: Model<T>, context: TranscriptContext,
          options?: ApiStreamOptions<T>): AssistantMessageEventStream
```

Transcript in, assistant stream out, in one method an application implements.
Overriding a built-in is the documented pattern, not a hack —
`registerBuiltinProviderModule` *"skips IDs that are already registered so
`app.ts` overrides win regardless of module evaluation order."* pi-ai
additionally offers `onPayload` (*"inspecting or replacing provider payloads
before sending"*) and an injectable `fetch`.

**The cost is two unstable surfaces.** `/internal` is non-public by name, and
taking it makes `@earendil-works/pi-ai` a direct dependency of this repo at
**0.86.1 — pre-1.0**, while Flue pins `^0.83.0`, which on a `0.x` package is
patch-only. We would compile against a `Provider` interface three minors ahead
of the one Flue actually calls. That is the plan's own "pre-1.0 breaking
changes" risk, landing on a package the plan never names.

### What ships instead, and why it is defensible

Guards go at the **tool boundary** — `guardUntrustedInput` on tenant content as
it is assembled, `guardEgress` on proposed tool arguments inside handlers this
repo writes — and not around the model call.

The argument is propose-not-commit itself. A model's text output is not an
action here; it becomes an `AgentProposal` a human reads and approves, already
covered by `guardAgentProposal` and the `guardVerdict` / `guardRuleIds` /
`guardInputDigest` columns on that table. `guardEgress` over raw model text
would be defence in depth. The load-bearing control is on **tool arguments**,
because a tool call *is* the action — and that is reachable from the public API,
inside code we own, routed through `runReadTool`, which already applies
exposure, the policy card, the autonomy ceiling, credential scope, the human
route's own permission check, redaction and one audit row per call.

What is given up is stated rather than glossed: **raw model output is not
egress-scanned**, and a decision-log row covers a response rather than a model
invocation.

### Point 5's caveat follows from point 4

`MODEL_CALL` records a *response*. `TOOL_CALL` records a real tool call, from
`response.toolCalls` — *"every tool call the response made, from the durable
record log"* — and every tool call this product admits also passes through
`runReadTool`, which audits it independently. Two records of one event by
different paths, which is why a `TOOL_CALL` step with no matching
`MCP_TOOL_INVOKED` audit row is a signal rather than a gap.

The value is named `MODEL_CALL` and not `RESPONSE` so that taking the provider
seam later changes row *density* and nothing else: no enum value retires, no
rows are rewritten, no migration is needed for the granularity to improve. The
price of that choice is that the name overstates what the row contains, which is
why the enum's own docstring in `prisma/schema/enums.prisma` carries the caveat
in full. Anyone counting these rows is counting responses.

## How this was checked

The packages were fetched with `npm pack` and their `.d.mts` / `.d.ts` files
read directly — `@flue/runtime@2.1.0` and `@earendil-works/pi-ai@0.86.1`. Every
quotation above is from a docstring in the published type declarations. Two
earlier readings were wrong and are recorded so the same mistakes are not
repeated: `@flue/sdk` was inspected first and is the *remote client*, not the
framework (its README names the right package); and the absence of
`ResponseStartContext` / `ResponseFinishContext` from the main entry's exports
was briefly read as "the types are elsewhere" when the correct reading is that
the contexts carry metadata only.

## Decisions

- **Adopt behind a driver seam, not directly.** Unchanged from the plan, but for
  the register/kill-switch reason rather than the maturity reason, which 2.1.0
  retired.
- **Refuse `@flue/postgres`.** It would be a second write path around RLS. This
  repo's isolation rests on `runInTenantContext` plus per-repository `tenantId`
  filters; a runtime holding its own pool answers to neither.
- **Refuse `useSandbox`.** Code execution inside a multi-tenant GRC application
  is not a capability this product should acquire as a side effect of adopting
  an agent runtime.
- **Skip Channels and Flue's own kill/stop controls.** The register already owns
  stopping an agent, and a second stop control that the register does not know
  about is worse than none — `agent-tool-exposure.ts` records why a control that
  silently does not apply is the dangerous shape.
- **Do not take `@flue/runtime/internal` yet.** Revisit if raw model-output
  egress scanning becomes a requirement, or when pi-ai reaches 1.0 and Flue's
  pin moves with it.
