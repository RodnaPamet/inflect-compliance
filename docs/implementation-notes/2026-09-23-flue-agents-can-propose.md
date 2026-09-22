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
- **`runProposeTool`'s `origin` is not supplied.** It takes an optional
  `{ runId, stepSeq }`, and this adapter has neither: it is a pure mapping over
  an invocation, built before dispatch, with no per-step identity. Threading it
  would mean `flueToolsFor` taking a run id from `execute.ts`.
- **The PROPOSALS cap is not charged on this engine.** `executeFlueRun` seeds
  the budget with `proposedItemsSoFar` and `wrapForLedger` charges `STEPS` and
  `TOOL_CALLS` only. That was harmless while no propose tool was reachable and
  is not any more — an open gap in `execute.ts`, which this change deliberately
  did not touch.
- **The derived valibot schema has no Zod cross-check on the propose side.**
  The read tools get one (same inputs through both schemas, same verdict
  required), because `argsSchema` is on `McpReadTool`. The propose envelope is
  module-private in `propose-tools.ts`, so its expectations are mirrored by hand
  in the test and nothing makes the two move together.
