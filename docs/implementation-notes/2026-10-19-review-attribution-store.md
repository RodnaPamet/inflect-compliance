# 2026-10-19 — The discovered-agent review's owner suggestion, stored for the intake dialog

**Commit:** _(this PR)_ `feat(agentic): store the discovered-agent review's parsed attribution so the intake dialog can suggest an owner (#3728)`

Follow-up of #3712 under the agentic IAM roadmap (#3654). The Register dialog on
the harness tab's shadow list could already render an owner suggestion. It showed
none, because no `discovered-agent-review` answer was parsed anywhere a page could
read it. The output contract (`parseOwnershipAttribution`) had one consumer, the
intake, which parses an answer the request carries. The tab could not carry one,
because its payload names no person (the #3687 rule).

## Design

```
run settles ─ executeFrom (workflow-runs.ts, the one seam both engines pass)
  └ captureReviewAttributionAfterRun(ctx, runId, key, status)   no-op unless the
      │                                                         review COMPLETED;
      │                                                         never throws
      └ captureReviewAttribution(ctx, runId)    THE ONE WRITER of DiscoveredAgentAttribution
          WorkflowRun: this workflow, COMPLETED, driver FLUE, nhi-ownership-attribution pinned
          openSealedContext → input.discoveredAgentId          (what the run was ASKED)
          AiDecisionLog (sessionRef = runId, feature agentic-run:discovered-agent-review,
                         newest row with text)                  (what the model ANSWERED)
          readAttributionFromAnswer  (lib/agentic/review-attribution.ts, pure)
            fenced ```json blocks / a whole-text object, ≤ 8 read, text ≤ 8000
            every attribution-shaped claim → parseOwnershipAttribution
            one answer, or identical repeats; else refused by name
          answer.discoveredAgentId === asked, and the agent exists in this tenant
          newest review wins (runCompletedAt); an older run is SUPERSEDED
          ▼
        DiscoveredAgentAttribution  (tenantId, discoveredAgentId) unique
          status · grade · unmatchedReason · signalsJson (person-free, encrypted)
          proposedOwnerRef (encrypted, server-side only) · runId · runCompletedAt

getHarnessMatrix (shadow list) ── selects everything but proposedOwnerRef
  └ ShadowRow.suggestion: { runId, runCompletedAt, status, grade, unmatchedReason, signals }

RegisterShadowAgentModal ── renders it as text; "keep" checkbox, on by default
  └ body.attribution = { runId } only while kept

registerShadowAgent ── attribution is the answer itself (unchanged) OR { runId }
  └ readStoredSuggestion → must be the row stored NOW (else SUGGESTION_NOT_STORED)
  └ storedSuggestionProvenance → the same provenance + runId; the person compared
    with the confirmed owner here and recorded as a boolean
```

## Files

| File | Role |
|---|---|
| `prisma/schema/agentic.prisma`, `auth.prisma`, `prisma/migrations/20261019090000_discovered_agent_attribution/` | The table, its back-relations, CHECKs, grants (no DELETE for `app_user`), RLS |
| `src/lib/agentic/review-attribution.ts` | Pure: read an answer through the contract; what is stored; the view a stored row gives |
| `src/app-layer/usecases/agent-harness-attribution.ts` | The capture (one writer), the after-run hook, the intake's server-side read |
| `src/app-layer/usecases/workflow-runs.ts` | Calls the hook at `executeFrom` |
| `src/app-layer/usecases/agent-harness-matrix.ts`, `src/lib/agentic/harness-read-model.ts` | `ShadowRow.suggestion`, `ShadowSuggestion` (no person member) |
| `src/app-layer/usecases/agent-registration-intake.ts`, `src/lib/agentic/registration-intake.ts`, `src/app-layer/schemas/agent-registry.schemas.ts` | `{ runId }` form of `attribution`, `SUGGESTION_NOT_STORED`, `runId` in the provenance |
| `src/app/t/[tenantSlug]/(app)/agents/reports/harness/{RegisterShadowAgentModal,HarnessTab}.tsx`, `messages/{en,bg}.json` | The suggestion shown, kept or discarded |
| `src/lib/observability/integration-metrics.ts` | `agentic.review_attribution.capture`, by outcome |
| `src/lib/security/encrypted-fields.ts` | `signalsJson`, `proposedOwnerRef` |

## Decisions

- **A new table, not the run's row.** `WorkflowRun`'s input is sealed and
  encrypted, so "the suggestion for agent X" could only be found by opening every
  review run. A `DiscoveredAgent` column would give the harness ingest's table a
  second writer. `DiscoveredAgentAttribution` has one writer and a unique key on
  the agent, so the shadow list reads it with one bounded `IN` query, and the
  intake reads it by key. The table is Operational: the Art 12 row is the record
  of the answer, and this row is a projection of that answer for one screen.
- **The answer is read from the Art 12 row, and the engine gets no second
  sink.** `flue-model-output-has-one-destination` holds the Flue engine to one
  destination for model text, `AiDecisionLog.outputSummary`, which is sanitised
  and bounded. The capture is a reader of that column. It turns the text into a
  row only through the contract, and only when the answer is about the agent the
  sealed context says the run was asked about. Nothing in `execute.ts` or
  `model-decision.ts` changed.
- **The trigger is the settlement seam, with no route.** `executeFrom` is where
  every run of either engine settles, which is why the settlement metrics are
  there too. No request can write a suggestion. The capture's authority is the
  run row it re-reads: this workflow, COMPLETED, Flue, the attribution skill
  pinned, in this tenant under RLS. The hook never throws, because a suggestion
  that cannot be stored is not a reason to fail a run that has completed.
- **The model is never chosen for.** Every claim that looks like an attribution
  must parse. If one claim fails, the whole answer is refused, and two different
  claims are `ANSWER_AMBIGUOUS`. Picking the claim that happens to parse would
  let a model hedge and have the hedge recorded as its view.
- **The person stays on the server.** `proposedOwnerRef` is selected by one
  reader, `readStoredSuggestion`, and only the intake calls it. The shadow
  list's `select` leaves it out. `ShadowSuggestion` has no member for it, which
  a `@ts-expect-error` test pins. The matrix integration test asserts its
  absence with a canary that is first shown to be in the stored row. Reverting
  the projection (selecting the column and spreading it into the view) turns
  that test red, and rendering a smuggled reference in the dialog turns the
  rendered test red. Both reverts were run.
- **The dialog sends a run id, never an answer.** It does not hold the
  person's reference, so it cannot send the raw answer, and must not. A run id
  names the row, and the intake refuses `SUGGESTION_NOT_STORED` when that run is
  no longer the stored one. Recording a newer suggestion in place of the one the
  person kept would put words in their mouth. The raw-answer form of
  `attribution` is unchanged for API callers.
- **Kept by default.** Keeping the suggestion records provenance: what it rested
  on, and whether the person agreed. It cannot choose the owner. Discarding is
  one untick, and a discarded suggestion sends no `attribution` at all.
- **Prose answers store nothing today.** The skill teaches prose, and the
  contract is JSON. A run stores a suggestion only when the model also gives the
  contract's object in a fenced block. Teaching the skill to do that changes
  its text and hash, so it needs a fresh evaluation record. That change belongs
  to the skill, not to this storage step. Until then every prose answer is
  counted as `no_attribution_in_answer`, so the gap is visible on a dashboard.
- **Newest wins, by the run's completion time.** An older run that finishes
  capturing late cannot replace a newer one. The update is conditional on the
  stored time, so two racing captures leave the newer review standing.
