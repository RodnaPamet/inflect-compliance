# 2026-09-29 — the external-write dwell counted a table nobody writes

**Issue:** #2861. Found while scoping the `PROPOSE_ONLY` rung.

## Design

The external-write ladder gates each widen on two axes: elapsed days, and
EVIDENCE that the current rung produced something. `MODE_MIN_EVIDENCE` asks
`DRY_RUN` for recorded intents and `PROPOSE_ONLY` for approved proposals.

`getExternalWritePolicy` supplied that number from `countRecordedIntents`, which
counted `IntegrationExecution` rows whose `automationKey` ended in
`:external-write`.

**Nothing has ever written such a row.** `EXTERNAL_WRITE_AUTOMATION_SUFFIX`
appeared in exactly two places in the repo: its own declaration, and that query.
The dispatch shipped in #2983 records intents as `ExternalWriteJournal` rows via
`recordIntent`. So the count was `0` for every connection on every request, and
`DRY_RUN → PROPOSE_ONLY` was refused with *"DRY_RUN has recorded 0 of the 1
required dry-run intents"* while the journal filled up beside it.

The constant's own docstring had predicted this exact failure. It argued against
a hardcoded `0` because that "would go on refusing after the dispatch shipped,
silently, until somebody remembered the line" — and then a query against a
population nothing writes turned out to be the same number as the literal it
replaced.

### Why it was invisible

`getExternalWritePolicy` computes each rung's refusal as:

```ts
refusals[rung] = isAboveClamp(rung, EXTERNAL_MAX_MODE) ? ceilingMessage : refusalForMove(...)
```

`EXTERNAL_MAX_MODE` is `DRY_RUN`, so every wider rung takes the FIRST branch and
`refusalForMove` is never reached for them. The evidence gate has therefore never
been exercised in production or in a test that could tell. It would have gone
live, broken, on the first diff that raised the clamp — the single change it
exists to guard.

### Why the journal is the right table, not the execution log

The schema had already said so, in three places written before this fix:

- `ExternalWriteJournal`'s header — "the dwell counts rows by `mode` and `outcome`";
- its `@@index([tenantId, mode, attemptedAt])`, commented "the dwell's evidence query";
- `ExternalWriteOutcome.RECORDED_ONLY` — "this is what the ladder's dwell COUNTS as evidence".

The index existed for exactly this query and had no caller. An external write is
also a TOOL CALL rather than a scheduled integration pass, and
`IntegrationExecution` models the latter — the identity ladder's nightly passes
are a genuine fit for it, and this is not.

## Files

| file | role |
|---|---|
| `src/app-layer/usecases/external-write-policy.ts` | `countRecordedIntents` → `countEvidenceForRung`; reads the journal, and is rung-aware |
| `src/lib/integrations/external-write-ladder.ts` | `EXTERNAL_WRITE_AUTOMATION_SUFFIX` deleted, tombstoned so it is not re-added |
| `tests/integration/external-write-policy.test.ts` | the evidence block; plus the fixture-user leak below |
| `tests/integration/external-write-journal.test.ts` | the same fixture-user leak |

## Decisions

- **`PROPOSE_ONLY` returns `undefined`, not `0`.** That rung is asked for approved
  proposals and nothing can produce one — `dispatchWrite` refuses the rung with
  `external_write_rung_unimplemented`. `refusalForMove` already distinguishes
  "could not look" from "looked and found none"; a `0` would have claimed the
  second. This keeps the rung fail-closed for a reason that is true, which is the
  precondition for raising the clamp later.

- **The constant was deleted rather than left for a future writer.** A name that
  describes a row shape nothing emits is what produced this defect; keeping it
  would keep the trap. The tombstone comment states where the evidence query now
  lives.

- **The pre-existing zero-case test could not have caught this.** With no journal
  rows AND no execution rows, both implementations return `0`, so it passed
  against the bug — a probe with no discriminating power. The new assertions were
  mutation-proved: reverting the query to `IntegrationExecution` reddens exactly
  two of them (`Expected: 1, Received: 0`) while the other 23 tests in the file
  stay green.

- **Two integration tests were not re-runnable, and that is fixed here rather
  than filed.** `resetDatabase` truncates a curated `RESET_TABLES` list that
  excludes `User` and `Tenant`, so each run's fixture user survived and the next
  `user.create` died on `User_emailHash_key` — inside `beforeAll`, failing all
  twelve journal tests on a constraint none of them are about. It presents as a
  suite that is red on main while being green in CI, because CI's database is
  fresh. Both files now delete the fixture user before creating it; the claim was
  verified by running each file twice in a row rather than once.

- **NOT done here: the `PROPOSE_ONLY` rung itself.** Wiring it to the existing
  `AgentProposal` queue is the next slice, and it is a design fork worth stating
  explicitly — `AgentProposalKind` is `RISK | CONTROL | POLICY | FINDING`, all
  internal entities with an internal `targetEntityId`, while an external write
  targets a record in a customer's system and its "before" is the journal's
  `priorStateJson`. Reusing the queue buys the four-eyes DB trigger, the output
  guard, expiry and sample audits; it costs an impedance mismatch in the review
  UI. That decision is the owner's and is not pre-empted by this fix.
