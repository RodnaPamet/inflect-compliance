# 2026-09-21 — A proposal traces to the step that produced it

**Commit:** `<sha>` feat(agentic): a proposal names its step, and a step names its proposals

Phase 1, point 3's frontend bullet: *"`/agents/proposals` gains a backlink to
the originating run; `/agents/runs` lists the proposals a run produced. Both
directions."*

## The read half alone would have been two dead links

`AgentProposal.runId` / `stepSeq` shipped with the provenance migration, and
the note that landed them said so plainly: *"nothing in the product writes to
any of it yet."* Every production row carried NULL in both columns. A PR that
built only the UI would have rendered a link that never appears, on every row,
indistinguishable from a bug.

So this carries the **writer** first: the driver's PROPOSE step now passes its
`(runId, seq)` down through `runProposeTool` into the one `AgentProposal`
create.

## Why `origin` is optional, when `policyCardVersion` is not

They sit two fields apart and take opposite positions, so the difference is
worth stating. `policyCardVersion`'s docstring argues at length that an
optional-with-fallback field is one callers will omit — and it is right, because
**a card version always has an answer**: `NO_POLICY_CARD` (0) is the real,
storable statement "there was no card".

A run has no such sentinel. `runProposeTool` has three callers and only one is
inside a workflow; the propose tools are callable directly by an agent that is
not executing one, and such a proposal genuinely has no step. The column's own
schema comment settles it: *"NULL IS A REAL ANSWER… reading NULL as 'unknown
run' would invent a run that never existed."*

So `undefined` here means "made outside a run" — a fact, not an omission.

### One object, not two optional fields

`AgentProposal_step_requires_run` CHECKs that a step ordinal naming no run is
unstorable. Two independent optionals make that half-state expressible in
TypeScript and rejected only at the insert; a single `origin` object makes it
unrepresentable on the way in too.

## Both directions

**Proposal → run.** The projection was the only thing in the way:
`listAgentProposals` has no `select`, so both columns were already arriving at
the page and being dropped. The link is conditional on `runId` rather than
disabled, because a disabled control would imply a run existed and was
unreachable.

**Run → proposals.** `getWorkflowRun`'s include gains `proposals` with an
**explicit select**. That usecase is returned verbatim by
`GET /agent-runs/:id`, so widening the include widens what the route emits —
and an `AgentProposal` carries `payloadJson`, the one column the proposals
surface deliberately refuses to send to a browser. Naming the fields keeps a
convenience here from becoming a leak there.

They are grouped onto steps by `stepSeq`, not looked up per step, because one
step may queue several — which is exactly why that column carries no unique
constraint.

## Why it matters on the run side specifically

A PROPOSE step's own `inputJson` records `{"count": N}` and **not** the items —
the driver keeps proposed content off the step row on purpose. So before this,
the ledger recorded that a propose happened and nothing at all about what it
proposed.

## Mutation proofs

Removing the driver's `origin` argument (the pre-PR state) reddens the
provenance test; pointing it at `stepSeq: 0` instead of `seq` also reddens it —
step 0 is the READ, which is what makes the "and it is the PROPOSE step"
assertion more than a presence check.
