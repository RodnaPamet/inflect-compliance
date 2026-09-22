# 2026-09-23 — Flue agents get propose tools, not just read tools

## Design

The integration plan's bullet reads "Flue agents get **read tools + propose
tools only**". The read half shipped; the propose half never did.
`flueToolsFor` iterated `loadableReadTools(inv)` and nothing else, so a Flue
agent was handed a way to look at a tenant and no way to write down what it
found. Under propose-not-commit an `AgentProposal` IS the output of a run, so
the agent could not finish a single piece of work — and nothing was red,
because an unoffered tool is an absence rather than a failure.

The offered set is now the union of two intersections, each composed from the
functions that already own its terms rather than restated:

```
read    = loadableReadTools(inv)     ∩ holdsScope ∩ withinCeiling(requiredAutonomyFor('read',    autonomy))
propose = loadableProposeTools(inv)  ∩ holdsScope ∩ withinCeiling(requiredAutonomyFor('propose', autonomy))
```

`loadableProposeTools` was extracted out of `listProposeToolDescriptors`,
exactly the split `loadableReadTools` / `listReadToolDescriptors` already has
next door, so the register grants, the policy card and the credential's propose
capability are read in one place and the adapter gets the tool OBJECTS it needs
to narrow further. `holdsScope` calls the funnel's own `enforceApiKeyScope`;
the rung comes from `requiredAutonomyFor(class, tool.authorize.autonomy)` —
**two** arguments, as both enforcement seams in `authorize.ts` pass, so a tool
declaring its own higher rung is not advertised and then refused on every call.

Propose is rung 2 and read is rung 1, so an agent at a ceiling of 1 is offered
the read surface and not the propose one. That asymmetry is the case that tells
a real composition from a copied read branch.

Execution routes through `runProposeTool`, selected by `isProposeTool(name)` —
the registry's own predicate, not a parameter with a default that would send a
propose name into the read funnel for any caller who forgot it. The adapter
touches no usecase and no Prisma: the funnel enforces the capability, the
domain scope, the rung and the principal's create permission, writes the audit
row, and queues a PENDING row a human approves. The guard sandwich is unchanged
and wraps both surfaces — egress on the model's drafted content BEFORE the
queue sees it, untrusted-input on the result, one `ReviewLatch` across both.

## The half that made the rest inert

Offering the tools was not sufficient, and the reason is worth keeping.

`toValibotInputSchema` refused array properties outright. Every propose tool's
`inputSchema` is `{ items: { type: 'array', items: { type: 'object' } }, … }`.
So all four threw, and the adapter turns that throw into an `omitted` entry
rather than an error — the propose surface converted to nothing, silently, with
the only signal in a field nobody reads. The converter's own test enumerated
`READ_TOOLS` and could never have seen it: a guard is as wide as the set it
enumerates.

`arraySchema` is the deliberate extension the converter's comment asked for. It
expresses an array of FREE-FORM objects (`v.record(v.string(), v.unknown())` —
the faithful reading of "an object", whose real contract is the create-schema
`createAgentProposal` applies to each item) and an array of scalars, carrying
`minItems` / `maxItems` through. It REFUSES an element that declares properties,
because widening a declared shape into a free-form record is the silent
reshaping this file exists to prevent.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/flue/tools-adapter.ts` | offers both surfaces; `offerTools` runs the probe once against what a read tool and a propose tool share; `runGuardedTool` dispatches to the right funnel |
| `src/lib/mcp/tools/propose-tools.ts` | `loadableProposeTools` extracted; the descriptor listing maps over it |
| `src/lib/agentic/flue/json-schema-to-valibot.ts` | `arraySchema` — array properties, refusing what it cannot express |
| `tests/unit/flue-tools-adapter.test.ts` | the propose half: both surfaces offered, the rung asymmetry, the override, the funnel dispatch, one latch |
| `tests/unit/flue-json-schema-to-valibot.test.ts` | `PROPOSE_TOOLS` joins the converted population; the new refusals |

## Decisions

- **`annotations.readOnlyHint` widened from the literal `true` to `boolean`.**
  It is a fact about which funnel a closure routes to, and a propose call is a
  write. `destructiveHint` stays literally `false`: a read changes nothing and
  a proposal queues a PENDING row, so nothing this adapter can emit destroys a
  record.
- **The principal's create permission is NOT probed at advertising time.**
  `listProposeToolDescriptors` deliberately does not, on the argument that an
  agent whose principal cannot create risks should still be told the tool
  exists — the refusal is the interesting event and belongs in the trail.
  Composing the existing function keeps one answer instead of two.
- **`runProposeTool`'s `origin` IS supplied, through a resolver.** The adapter
  still has no per-step identity of its own — it is a pure mapping over an
  invocation, built once before dispatch — so `flueToolsFor` takes an optional
  `OriginResolver` keyed by `toolCallId` instead of a run id. `wrapForLedger`
  allocates the step seq before it invokes the tool and records it in a map the
  resolver reads; a `finally` forgets the entry, symmetrically with
  `takeVerdict`'s delete and for the same two reasons (it leaks for the life of
  the run, and a recycled id would inherit a step that was not its own). Keyed
  rather than held in a field because the runtime may have more than one call
  in flight. The resolver reaches only the propose surface: a read writes no row
  that could carry an origin, and passing it to both would read as though a read
  were being attributed somewhere.
- **The PROPOSALS cap is charged, PER ITEM.** `executeFlueRun` had always
  seeded the budget from `proposedItemsSoFar` while `wrapForLedger` charged
  `STEPS` and `TOOL_CALLS` only — harmless exactly as long as nothing on this
  engine could propose, and an escape the moment one could. The charge is by
  item count, not by call: `proposeArgs` accepts 1–20 items and
  `runProposeTool` queues one PENDING row for each, so charging the call would
  let a run reach twenty times its cap with the counter reading correct. That
  is the escape point 5 of the plan names — "a loop cannot escape the cap by
  spending in a kind the counter ignores" — one level down: a kind charged at
  the wrong unit.

  `proposedItemCount` lives in `propose-tools.ts`, beside the `proposeArgs`
  envelope whose 1–20 rule it mirrors, not in `execute.ts`. Two reasons: a
  second copy of the rule is how a cap ends up charging the wrong unit, and
  `execute.ts` cannot be imported under the `node` jest project at all
  (`@flue/runtime` is ESM-only), so a helper living there could only ever be
  asserted about as source text. It reads the RAW args, before validation,
  because the charge happens before the funnel — the point of charging early
  being that a refusal means nothing was queued. An uncountable shape answers
  ONE, never zero: free is the only answer a cap cannot recover from.

  The predicate is `isProposeTool`, the same registry call the adapter
  dispatches on. A second way of answering "is this a propose tool" — the
  `readOnlyHint` annotation, a name prefix — is a way for the charge and the
  funnel to disagree, and the disagreement that matters is a propose call the
  funnel runs and the counter never sees.
- **The derived valibot schema has no Zod cross-check on the propose side.**
  The read tools get one (same inputs through both schemas, same verdict
  required), because `argsSchema` is on `McpReadTool`. The propose envelope is
  module-private in `propose-tools.ts`, so its expectations are mirrored by hand
  in the test and nothing makes the two move together.
