# 2026-09-22 — bulk reject on the agent-proposal review queue

## Design

The propose-not-commit queue could be cleared only one row at a time. A
reviewer working through a backlog of agent drafts had no way to refuse a batch,
which is the automation-bias problem the queue exists to resist arriving from
the other side: a queue too slow to clear is a queue people stop reading.

The shape is the one the register bulk verbs already use — an optimistic removal
plus a deferred commit behind `useToastWithUndo`, with the real request firing
when the undo window closes — over a NEW ATOMIC ROUTE rather than a client loop
over the single-reject endpoint.

```
AgentProposalsClient.bulkReject()
  ├─ optimistic: drop the ticked rows from local state, clear the selection
  ├─ triggerUndoToast({ … })            5s window, module-scoped timer
  │    └─ action:  POST /api/t/:slug/agent-proposals/bulk/reject
  │                 └─ bulkRejectAgentProposals(ctx, ids)
  │                      ├─ assertCanWrite(ctx)
  │                      ├─ ONE tenant-scoped read   → classify every id
  │                      ├─ refusals audit individually (the existing helpers)
  │                      └─ ONE transaction          → updateMany + decision log
  │    └─ reconcile: any id the server did NOT move goes back on the list
  └─ undoAction: restore the snapshot; nothing was ever sent
```

## The atomicity decision

"Atomic" is ambiguous the moment some rows are legitimately un-rejectable. The
choice was between refusing the whole batch when any one row cannot be rejected
and rejecting the rejectable rows while reporting the rest.

**Chosen: reject-what-is-rejectable-and-report, atomic over the accepted
subset.** The reasoning is the queue's physics rather than a preference for
leniency. The un-rejectable states — already decided, expired, quarantined, not
found — are not caller mistakes: a row expires on a clock, a teammate decides one
from their own tab, and the reviewer's browser is working from a list rendered
before any of that. The undo window deliberately widens that gap by five
seconds. So a stale row is the ordinary case, and all-or-nothing would let one of
them veto a batch of fifty, with the operator given a refusal and no way to learn
which id to deselect. Retrying would fail again.

What IS atomic is real and is the half worth having: the accepted ids move to
`REJECTED` together with their decision-log outcomes inside a single
`runInTenantContext` transaction, so no batch can leave a row rejected while its
AI-decision log still says a human is deciding.

The response says which rows were acted on rather than counting them:

```ts
{ rejected: string[], skipped: Array<{ id, reason }> }
// reason ∈ NOT_FOUND | QUARANTINED | EXPIRED | NOT_PENDING
```

A count cannot tell an operator WHICH of their fifty survived. The UI reconciles
against the ids — rows the server did not move go back on the list rather than
vanishing on the optimistic assumption that the whole batch would go.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/agent-proposals.ts` | `bulkRejectAgentProposals` — classify, audit the refusals, one transaction for the accepted subset |
| `src/app/api/t/[tenantSlug]/agent-proposals/bulk/reject/route.ts` | The route. `withApiErrorHandling` + `parseJsonBody`; authorization stays at the usecase, matching its single-proposal sibling |
| `src/lib/schemas/index.ts` | `BulkAgentProposalRejectSchema` — same 1..100 batch cap as the register bulk verbs |
| `src/app/t/[tenantSlug]/(app)/agents/proposals/AgentProposalsClient.tsx` | Row checkboxes, the selection bar, and `bulkReject` through `useToastWithUndo` |
| `tests/guards/epic-67-rollout-coverage.test.ts` | The new `SITE_CONTRACTS` entry |
| `messages/{en,bg}.json` | `agents.proposals.bulk.*` in both locales |
| `public/openapi.json` | Regenerated — the route walker publishes the new path as a stub |
| `tests/integration/proposal-bulk-reject.test.ts` | Behavioural cover for the decision above |

## Decisions

- **A batch route, not a client loop.** N requests can half succeed, and the
  browser is then the only place that knows which half — a fact it loses on
  navigation. One request answers with both halves.
- **The refusals reuse `refuseQuarantined` / `refuseExpired` and swallow their
  throw.** Those helpers are where the `AUTHZ_DENIED` row is written, and the
  quarantine one exists precisely so that attempting to clear a quarantined row
  leaves a trail. Re-implementing the audit here would have let bulk become the
  quiet way to attempt disposal of evidence; letting the throw propagate would
  have aborted the other forty-nine.
- **`status: 'PENDING'` is re-asserted inside the transaction, and the moved
  ids are READ BACK rather than inferred from a count.** The classification
  runs on a read taken before the write, so the predicate on the `updateMany`
  is what stops a row decided in between from being overwritten — and it can
  therefore match fewer rows than were accepted. A count says how many survived
  without saying which, so the transaction re-selects the rows carrying this
  call's own reviewer-and-instant stamp; anything accepted but not written
  joins `skipped` as `NOT_PENDING`, which is what it now is. The response can
  then never name an id this call did not write.
  *Not covered by a test:* that race needs a concurrent decision landing
  between the two statements, which the integration suite does not stage.
- **Absent and foreign-tenant both answer `NOT_FOUND`.** Telling them apart
  would confirm that an id exists in a tenant the caller cannot see.
- **No route-level `requirePermission`.** `/agent-proposals` is not a layer-1
  privileged root, and its single-reject sibling authorizes at the usecase. A
  gate on one of the pair and not the other would let the bulk path and the
  single path disagree about who may reject.
- **Ids are de-duplicated at the seam.** A repeated id would otherwise be
  counted twice in the result and audited twice for one decision.
