# 2026-10-03 — the unattended AUTOMATIC arm of the external-write ladder

**Issue:** #2861 (the ladder) / #3051 (the bounded templates it stands on).

## Design

`DRY_RUN` journals and sends nothing. `PROPOSE_ONLY` queues an `AgentProposal`
and a human signs it. `AUTOMATIC` is the rung with no human in it, and the whole
diff follows from that one difference.

```
  tool call (external-tools.ts: run)
    │  open VALUE fields → refusalForValue          ← every rung, unchanged
    │  TARGET field      → resolveTargetPopulation  ← every rung, unchanged
    ▼
  dispatchWrite
    │  prior-state pairing + read                   ← every rung, unchanged
    ├─ DRY_RUN       recordIntent, terminal
    ├─ PROPOSE_ONLY  createAgentProposal
    └─ AUTOMATIC     openAutomaticExternalWrite ────┐   NEW
                       1 clamp (EXTERNAL_MAX_MODE)  │
                       2 a parameter SET must exist │
                       3 rolling-window cap         │
                       4 beginWrite  → PENDING row  │
                       5 logAiDecision → AUTONOMOUS │
                                                    │
  external-write-dispatch (the ONLY sender) ◄───────┘
       connection rung  →  row rung  →  pairing  →  DRIFT
                                                     ├─ PROPOSE_ONLY: prior state moved?
                                                     └─ AUTOMATIC:    does the BOUND still admit it?
```

## Files

| File | Role |
| --- | --- |
| `prisma/schema/enums.prisma` | `AiHumanOutcome.AUTONOMOUS`, declared LAST so a plain `ADD VALUE` matches |
| `prisma/migrations/20261003100000_ai_human_outcome_autonomous/` | the enum value, `IF NOT EXISTS`, alone in its migration |
| `prisma/schema/agentic.prisma` | `ExternalWriteJournal.parameterSetLabel` |
| `prisma/migrations/20261003100100_external_write_journal_parameter_set_label/` | that column |
| `src/app-layer/usecases/external-write-automatic.ts` | the arm, the clamp helper, the send-time bound re-check, the rung-narrowing check |
| `src/app-layer/usecases/external-write-dispatch.ts` | mode-aware drift; the row-rung narrowing check |
| `src/app-layer/usecases/external-write-journal.ts` | `parameterSetLabel` on the write seam |
| `src/app-layer/ai/decision-log/index.ts` | an optional write-time `humanOutcome`, typed to the one value |
| `src/lib/agentic/evidence-artefact.ts` | a third bucket in `buildDecisionArtefact` |
| `src/lib/mcp/tools/external-tools.ts` | the `AUTOMATIC` branch of `dispatchWrite` |
| `src/app/t/[tenantSlug]/(app)/agents/decisions/DecisionsClient.tsx` + both locales | the new value's tone and label |
| `tests/guards/external-write-clamp-is-propose-only.test.ts` | the literal pin — SUPPOSED to fail on a clamp raise |

## Decisions

- **The Art 12 record is an `AiDecisionLog` row stamped `AUTONOMOUS`, and no
  `AgentProposal` is written.** A proposal with no possible approver can never be
  approved, and a `PENDING` decision-log row is the same lie one table over:
  `buildDecisionArtefact` would report a "still pending review" backlog that only
  grows. The value is terminal at INSERT; the append-only trigger is
  `BEFORE UPDATE` only, so a row created terminal needs no DDL, and the trigger's
  `OLD.humanOutcome <> 'PENDING'` arm then refuses to restamp it.

- **`AiDecisionOutcome` (the Art 14 stamp's argument type) deliberately excludes
  it.** The stamp moves a row that WAS `PENDING` because a person acted; an
  `AUTONOMOUS` row was never pending and no person acted.

- **`buildDecisionArtefact` counts three buckets from positive lists, not a
  subtraction.** `reviewed = facts.length - pending.length` counted every
  autonomous row as an Art 14 outcome. The first fix was
  `!== 'PENDING' && !== 'AUTONOMOUS'`, which has the same flaw one step smaller —
  it absorbs the next enum member into "supervised" — so the review verdicts are
  listed and a shortfall is printed as `NOT CLASSIFIED`.

- **Dispatch goes through the job.** `openApprovedExternalWrite` does `beginWrite`
  and returns the journal id; it never calls `callTool`. The job is the only
  sender, and it sweeps `outcome: 'PENDING'` — which is what `beginWrite` writes.
  Sending inline would be the novelty that creates the double-send.

- **Drift means something different per rung, and the code says what.** At
  `PROPOSE_ONLY` a person read ONE record, so the check is "has that record
  moved". At `AUTOMATIC` nobody read it, so that check has no referent and would
  refuse whenever the far end is busy. What was approved is the template and its
  bounds, so the send-time check re-asks those: the set still exists under the
  row's label, its bounds still parse, every open value still satisfies its
  constraint, and the target is still in the population **re-resolved now**. The
  prior state is still read and journalled before anything leaves, at both rungs;
  it is simply not re-compared, and the stored copy is never overwritten.

- **The clamp got a second enforcement point, and a literal pin.**
  `EXTERNAL_MAX_MODE` was read only by `setExternalWriteMode`;
  `dispatchWrite` never consulted it, so a row already holding the rung when the
  ceiling came down would have been sent. `automaticClampRefusal` is the
  dispatch-time half, used by the arm and the job. Separately, no test pinned the
  constant's VALUE — the pin is a deliberate tripwire whose only correct
  behaviour is to break when the constant changes. **`EXTERNAL_MAX_MODE` stays
  `PROPOSE_ONLY`.**

- **The runaway bound is per CONNECTION, per rolling hour, and refuses.** The run
  cap bounds a run; the failure this rung introduces is a bad POPULATION FEED —
  an HR import marking four thousand workers `TERMINATED` — where every call is
  legitimately in bounds and the volume is spread across as many runs as the
  scheduler starts. `DISPATCH_BATCH_LIMIT` is also 50 and is a different
  mechanism: a per-tenant page size that refuses nothing. Both constants now say
  so at their declarations.

- **`parameterSetLabel` is a new column because the send-time check needs it.**
  Nullable (the rungs below `AUTOMATIC` permit a set-less call), unencrypted (a
  label is operator metadata, like `toolName` beside it), unindexed (nothing
  filters on it — the lookup it feeds is against `ExternalToolParameterSet`'s
  own unique index).

- **A pre-existing environmental defect, left alone.**
  `tests/integration/external-write-policy.test.ts` and
  `tests/integration/external-prior-state-read.test.ts` are not re-runnable
  against a database they have already run against: `resetDatabase` does not
  truncate `TenantMembership` (documented at length in `tests/helpers/db.ts`), so
  their `beforeAll` cleanup trips a foreign key. CI never sees it because each job
  gets a fresh database. The new suite here avoids it with the
  `session_replication_role = 'replica'` delete the sibling target-population
  suite already uses, and is proved re-runnable; fixing the other two is not in
  this diff's scope.
