# 2026-09-20 — Handing our MCP tools to someone else's agent loop

**Commit:** `<sha>` feat(agentic): Flue tools adapter + the guard sandwich at the tool boundary (3/3)

PR 3 of three. The bridge from this product's MCP read tools to the shape an
external agent runtime's `useTool` takes — with every authorization decision
left exactly where it was.

**`DRIVER_IMPLEMENTED.flue` stays `false`.** This PR builds and proves the
bridge; nothing executes a Flue agent yet. The flip belongs in the diff that
first runs one.

## Design

    external engine  →  decides WHAT TO TRY
    runReadTool      →  decides WHAT IS PERMITTED

Every tool this adapter emits routes its `run` through `runReadTool`, so an
agent driven by third-party code passes the identical gate a human-driven MCP
call does: token audience, credential liveness, deny-by-default exposure, the
autonomy ceiling, the policy card, credential scope, then the same
`assertPermission` / `assertCan*` the equivalent human route uses — one
hash-chained audit row per call and per refusal. Nothing here re-implements any
of it.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/flue/tools-adapter.ts` | the bridge, the narrowing, the guard sandwich, the compile-time contract check |
| `src/lib/agentic/flue/json-schema-to-valibot.ts` | JSON Schema → valibot, derived rather than hand-written |
| `src/lib/mcp/tools/registry.ts` | `loadableReadTools` extracted so the adapter and `tools/list` share one filter |
| `package.json` | `@flue/runtime@2.1.0`, `valibot`, and `overrides.valibot` → `$valibot` |

## Decisions

### The advertised set is narrower than MCP's, on purpose

`loadableReadTools` gives exposure ∩ register grants ∩ policy card ∩ the
principal's permissions — what `tools/list` advertises. It stops there because
credential scope and the autonomy ceiling are call-time decisions that write
audit rows, and a listing must not make an authorization claim it records
nothing for.

The adapter narrows by those two as well, because the consumer is different: an
MCP client is a program that can handle a 403, while a language model handed a
tool it will always be refused plans against it and burns the run. The
registry's own history is the argument — the card term was missing from that
listing once, and the recorded consequence was that "every call it planned
against the difference 403'd".

The narrowing is an ADVERTISING probe and never an enforcement. It throws
nothing, writes nothing, and a tool that slips through is still refused by the
funnel with a proper audit row. Both terms call the funnel's own functions;
`holdsScope` wraps `enforceApiKeyScope` in a try/catch rather than re-reading
`ctx.apiKeyScopes`, because the scope vocabulary has wildcard forms and a
session-auth no-op and a second reading of those rules is the
four-verbatim-copies failure again.

### Where the guard sandwich actually went

The integration plan asked for AI Guard around every model call. Flue's public
API cannot carry that — see
[the API verification note](2026-09-20-flue-2-1-0-api-verification.md). So it
sits at the tool boundary, and both slices are load-bearing:

- **egress on the proposed ARGUMENTS, before the funnel.** A tool call is the
  action, and the guard sits in front of the thing it guards rather than beside
  it.
- **untrusted-input on the RESULT, before it returns to the model.** Tool
  results are where tenant-authored content enters an agent's context — a risk
  description carrying "ignore previous instructions". Guarding the assembled
  prompt would have caught the same text later and with less context.

What is given up, stated rather than glossed: the model's own free-text output
is not egress-scanned. Under propose-not-commit that output is not an action —
it becomes an `AgentProposal` a human reads, already covered by
`guardAgentProposal` and the guard columns on that row.

### The converter is derived, and refuses what it cannot express

Each tool now declares its arguments three times: JSON Schema (MCP's wire
format), Zod (what the funnel enforces), and valibot (what the runtime wants).
Three representations are three chances to disagree, so the valibot one is
DERIVED. Every construct outside the subset throws rather than degrading — a
converter that quietly emitted "any object" would hand the model a tool it
cannot call correctly with no signal — and a tool whose schema will not convert
is dropped from the offered set with `UNCONVERTIBLE_SCHEMA` rather than offered
unschema'd.

A defect in here cannot weaken enforcement. `runReadTool` validates against Zod
regardless, so the worst case is a misdescribed argument list, which produces a
rejected call rather than an unchecked one.

## Three things that were wrong, and what caught each

**The compile-time check earned its place twice.** `__assertDescriptorIsALegalFlueTool`
is never called; it exists so `tsc` proves the locally-declared descriptor is a
legal `useTool` argument. The first draft declared `run: (args) => ...` when the
real contract passes a `ToolContext` whose validated arguments arrive as
`context.data` — a descriptor that would have type-checked perfectly against a
hand-written interface and called every tool with `undefined`. The second draft
then typed `data` as `Record<string, unknown>`, which is unassignable because
`ToolInputSchema`'s output parameter is `unknown` and a parameter type must be a
supertype. Both were compile errors rather than 3am pages.

**The cross-check found a real disagreement immediately.** The converter test
runs the same inputs through the derived valibot schema and each tool's own Zod
schema and requires the same verdict. On first run, **8 of 10 tools disagreed**:
`v.object` ignores unknown keys, while every live tool declares
`additionalProperties: false` *and* a strict Zod schema. The converter had been
written with the reasoning "the funnel is the authority, so this layer need not
reject" — sound reasoning, wrong conclusion, because advertising something the
enforcement layer will refuse is the exact failure this adapter exists to
prevent. `additionalProperties` is now honoured in both directions.

**A test assumption, not a finding.** The first population test asserted `{}` is
a legal call for every tool. Two tools genuinely require arguments. It now
asserts the derived invariant — a tool rejects `{}` if and only if its schema
declares something required — which tests that `required` is honoured without
hard-coding today's catalogue.

## Dependencies

`@flue/runtime@2.1.0` (118 transitive packages) and `valibot`, which was already
in the tree transitively and is now declared rather than imported as a phantom.

**Adding them introduces no new advisories**, and that was measured rather than
assumed. `@flue/runtime` pins `hono` at exactly `4.12.32`, which carries four
advisories (one fixed in 4.12.34, three in 4.13.5). This repo *already* overrides
`hono: ^4.13.5` — pre-positioned, though hono was not previously in the tree — so
it resolves to 4.13.8 and the tree audits clean. `npm audit --omit=dev` reports
the same 2 pre-existing high advisories (`image-size` via `pptxgenjs`) before and
after, and `scripts/audit-gate.mjs` passes with "2 tracked exemptions, all
matched and in date".

`overrides.valibot` moved from `^1.4.2` to `$valibot` — npm refuses an override
whose range differs from a direct dependency's (`EOVERRIDE`), and `$name` is the
repo's existing idiom for exactly this, already used for `$undici` and
`$postcss`.

## What this does not do

No agent is executed. No `MODEL_CALL` or `TOOL_CALL` step is written — those
values exist from PR 1 and stay unwritten until something runs. `@flue/postgres`
is refused (a second write path around RLS) and `useSandbox` is refused (code
execution in a multi-tenant GRC application). Channels and Flue's own kill/stop
controls are skipped: the register already owns stopping an agent, and a second
stop control the register does not know about is worse than none.
