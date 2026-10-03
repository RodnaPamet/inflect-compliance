# 2026-10-02 — the PROPOSE_ONLY evidence gate counts real approvals

Step 4 of #2861. `countEvidenceForRung` in
`src/app-layer/usecases/external-write-policy.ts` returned `undefined` for
`PROPOSE_ONLY` on a premise step 6 falsified.

## Design

`MODE_MIN_EVIDENCE.PROPOSE_ONLY` asks that rung for **approved proposals**
before `PROPOSE_ONLY → AUTOMATIC` may be granted. The branch returned
`undefined` ("could not count") because, as its header said, *"no external
write can be proposed yet — `dispatchWrite` refuses the rung outright with
`external_write_rung_unimplemented`"*. Step 6 raised `EXTERNAL_MAX_MODE` to
`PROPOSE_ONLY`, so that sentence stopped being true: the rung is reachable,
`dispatchWrite` queues an `AgentProposal` of kind `EXTERNAL_WRITE` at it, and
`approveAgentProposal` applies one.

Nothing was unsafe in the interval, and the same fact explains why the
falsification was invisible: the only move that asks this rung for evidence is
`PROPOSE_ONLY → AUTOMATIC`; `AUTOMATIC` is above the ceiling; and
`getExternalWritePolicy` consults `isAboveClamp` **before** `refusalForMove`.
No caller has ever read the number. That is precisely the shape #2993 found in
the `DRY_RUN` gate, and the argument for fixing it now rather than in the diff
that raises the ceiling again.

### The join

The count is per connection and per window. `AgentProposal` has **no
`connectionId`** — the connection lives inside `payloadJson`, which is a
`String` in `ENCRYPTED_FIELDS` and therefore unfilterable in SQL. Counting
proposals directly would mean reading every accepted `EXTERNAL_WRITE` proposal
in the window, decrypting each payload and matching in JS.

So the join goes through the row the **approval writes**.
`approveAgentProposal` calls `openApprovedExternalWrite` only once the full
`requiredApprovals` count of distinct humans has signed, and that opens an
`ExternalWriteJournal` row carrying `connectionId` and the rung it was approved
under. The biconditional is exact:

> a journal row at `mode = 'PROPOSE_ONLY'` ⟺ an `EXTERNAL_WRITE` proposal
> against that connection met its approval requirement and a human committed to
> the write

because `recordIntent` throws on any mode but `DRY_RUN`, `beginWrite` refuses
`DRY_RUN` and `DISABLED`, `openApprovedExternalWrite` is `beginWrite`'s only
external-write caller, and `external-write-dispatch` only ever *settles* rows it
did not create. The row is also the better evidence: it is written by the
approval, under the rung re-checked at that instant, and it is what
`AgentProposal.createdEntityId` points at.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/external-write-policy.ts` | `EVIDENCE_PREDICATE` table replaces the `if (mode === 'DRY_RUN')` chain; `DISPATCHED_OUTCOMES`; `EVIDENCE_COUNTABLE_RUNGS` exported for the invariant test; both stale header sections rewritten |
| `tests/unit/external-write-evidence-count.test.ts` | New. Asserts the `where` per rung, the `MODE_MIN_EVIDENCE` ⟷ countable-rungs invariant, and that an uncountable rung issues no query |
| `tests/integration/external-write-policy.test.ts` | The old "PROPOSE_ONLY is UNCOUNTABLE" test becomes the `AUTOMATIC` case; a new block drives real approvals through `openApprovedExternalWrite`. **Unrun** — see Decisions |

## Decisions

- **A predicate TABLE, not a switch.** The rungs the counter can answer for have
  to be enumerable, so a unit test can hold them against
  `MODE_MIN_EVIDENCE`'s keys. A rung that demands evidence and has no predicate
  is a gate that can never be satisfied — "could not count" for ever — which is
  #2993's failure in a new costume, and no type catches it because
  `MODE_MIN_EVIDENCE` is a value.
- **`undefined` is not collapsed into 0.** A rung absent from the table returns
  `undefined`, and `refusalForMove` keeps its separate sentence for it.
  `AUTOMATIC` is the live case: top rung, nothing widened off it, no requirement
  listed — so there is no question and a 0 would claim an answer.
- **Every dispatched outcome counts; `RECORDED_ONLY` does not.** What the rung
  must prove is that humans reviewed external writes. Narrowing to `APPLIED`
  would let an unreliable far end hold a tenant at `PROPOSE_ONLY` for a reason
  with nothing to do with human review. `RECORDED_ONLY` is excluded as a
  positive list rather than a negation: an outcome value added later is silently
  *counted* by `{ not: … }` (authority widens) and silently *excluded* by a list
  (gate stays shut).
- **`AUTOMATIC` is untouched.** `EXTERNAL_MAX_MODE` stays `PROPOSE_ONLY`; this
  change makes the number true, not the rung reachable.
- **No operator-facing figure changed meaning.** `evidenceInWindow` is typed in
  `ExternalWriteLadderClient`'s payload but never rendered, and the only string
  that embeds the count is the `PROPOSE_ONLY → AUTOMATIC` refusal, which the
  ceiling branch replaces before `refusalForMove` runs.
- **The integration tests are UNRUN.** They write to the shared test database,
  which was not writable in the environment this was authored in. `tsc`
  typechecks them (verified with a deliberate error as a positive control); the
  unit test was run and mutation-proved four ways.
