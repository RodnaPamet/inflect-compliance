# 2026-10-09 — An expired assignment is not a holding

**Commit:** see the PR for #3326 — `fix(entra): classify assignment liveness so an expired one is not a holding`

## The defect

`readAssignments` (shipped by #3308) filtered on the target and the package and
**not on state**, and returned a bare array. Microsoft does not remove an
expired assignment — it stays in the collection with `state: Expired` — so the
read returned history and holdings mixed together.

Every row carried its own `state`, so the DATA was complete. The defect was in
what the shape invited a caller to conclude. For a subject whose only assignment
expired last month, the array has length 1, and:

| the question | what `length > 0` says | the truth |
| --- | --- | --- |
| does the subject already hold this? | yes | no |
| would the grant be a no-op? | yes | it is exactly what is needed |

**The direction of the error is the bad one.** A grant suppressed as redundant,
for somebody whose access has lapsed, is a denial of access wearing the costume
of an optimisation — and because the row is a real assignment with a real end
date, nothing about it looks suspicious in the journal.

## Measured against the live directory, not a fixture

A watch left running over the #3311 test assignment (tenant `5c459bc6`, end date
`2026-10-09T07:17:11Z`) recorded both halves of this defect:

| observed at | `state` | `endDateTime` | rows returned |
| --- | --- | --- | --- |
| 07:20:22Z | `delivered` | 07:17:11Z — **already past** | 1 |
| 07:25:23Z | `delivered` | 07:17:11Z — **already past** | 1 |
| 07:35:24Z | `expired` | 07:17:11Z | 1 |
| 07:50:26Z | `expired` | 07:17:11Z | 1 |
| 08:10:29Z | `expired` | 07:17:11Z | 1 |
| 08:40:31Z | `expired` | 07:17:11Z | 1 |
| 09:10:34Z | `expired` | 07:17:11Z | **1** |

Two facts, both load-bearing and neither inferable from the documentation:

- **A `delivered` row outlived its own end date by at least 8m12s** (last seen
  `delivered` at 07:25:23Z against an end of 07:17:11Z; first seen `expired` at
  07:35:24Z, so the window is between 8m12s and 18m13s). This is why
  `state === 'delivered'` cannot decide liveness alone, and it is a longer
  window than the 2m30s recorded on #3324.
- **The row count never dropped.** One row at 07:20, one row at 09:10 — 1h53m
  after expiry. So `assignments.length > 0` is true forever after a single
  grant, for as long as the directory keeps the record. The old shape could
  not have been right for any subject who had ever held the package.

## Why a `state eq 'Delivered'` filter was not the fix

Two reasons, and the second is the one that cost a design round.

**It throws away the better half.** `priorStateJson` is an audit artefact, and
"this subject previously held this package until 2026-09-01" is exactly what an
assessor wants. Filtering the history out of the read to simplify a boolean
would be discarding the record to fix the question.

**`state` is not sufficient on its own.** #3324 measured an assignment sitting
at `state=delivered` with an `endDateTime` already in the past — Entra had not
yet processed the expiry. So neither field decides alone, and a filter pinned to
`Delivered` would still report that row as a holding.

## The shape

```ts
export interface AssignmentReadResult {
    readonly all: readonly AccessAssignmentState[];   // the audit record
    readonly live: readonly AccessAssignmentState[];  // the answer
}
```

`live.length > 0` is the no-op test and nothing else can be mistaken for it. The
old call shape `assignments.length` is now a type error, so every call site was
forced to be read rather than silently inherited — the same forcing function the
#3323 path deletion provided.

## Files

| file | role |
| --- | --- |
| `…/providers/entra-id/entitlement.ts` | `AssignmentLiveness`, `classifyAssignment`, the shaped return |
| `…/usecases/entra-grant-dispatch.ts` | `AssignmentReadOutcome` carries the result, not an array |
| `tests/unit/entra-entitlement-grant.test.ts` | the classifier table, the defect, the batch clock |

## Decisions

- **Four liveness values, not two.** The issue proposed `{ live, historical }`.
  That is wrong for `delivering` and `partiallyDelivered`, which are in flight:
  not held yet, and **not history**. Filing them under `historical` would have
  been this very defect a second time — a field read as something it is not. So
  the union is `live | pending | inactive | unknown`, and a caller can tell "a
  grant is already in flight" from "they held it and it lapsed", which are
  different operator actions.

- **`unknown` never collapses into `inactive`.** An unrecognised state —
  including `unknownFutureValue`, which Graph reserves for enum members added
  later — and an unparseable date both return `unknown`. Classifying a value
  this code has never seen, in either direction, is how a new state becomes
  silently live.

- **The boundary is strict (`end > now`), and the tie breaks toward writing.**
  Inside the #3324 window neither field is trustworthy, so `delivered` with a
  past end date is `inactive`. Calling it inactive when access is in fact still
  live means attempting a grant Entra may reject as already-assigned — a visible
  error. Calling it live when access has lapsed means suppressing the grant — a
  silent denial. The first is noisy and recoverable, the second is quiet and
  harmful.

- **Case-insensitive on purpose.** The live Graph v1.0 payload carries
  `delivered` lowercase; the documentation and the portal filter both say
  `Delivered`. A comparison pinned to either spelling passes against a fixture
  written from the other and fails against the API. Asserted both ways round.

- **One clock reading per batch.** `now()` is called once before the rows are
  walked, not per row. Classifying against a moving clock could put two rows
  with the same end date in different buckets, which is not a thing the
  directory said.

- **`live` is derived in the client, not left to the caller.** A caller that has
  to filter is a caller that can forget to, and the forgetting looks like
  nothing.
