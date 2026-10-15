# Inline approve/reject on the process canvas (#3472, plan point 08)

The last item of Flue 08. The canvas already badged a run parked on a
`HUMAN_CHECKPOINT` (#3548); this is the half that lets a reviewer do something
about it without leaving the map.

## The constraint did most of the design

> **Approve/reject from the canvas goes through the SAME usecase as
> `/agents/proposals`** — no second approval path.

Taken literally, which is the only useful way to take it: the panel POSTs to
`/agent-proposals/:id/approve` and `/agent-proposals/:id/reject`, the routes the
queue surface uses. **Nothing new decides anything.** The only new server code
is a READ — `getRunCheckpointReview` — and the route that serves it declares no
mutating handler at all.

That is worth more than it sounds. Every rule the queue applies now applies here
without being restated:

- quarantine refused **before** the status check, as a 403 that writes an
  `AUTHZ_DENIED` row rather than a 400 about sequencing;
- the approval window checked **against the clock**, not against the status, so
  a nightly sweep's punctuality is not what enforces a deadline;
- four-eyes refusing an edit after the first signature, because merging one
  approver's edits would commit content no two people agreed on;
- the `baseDigest` re-check, which is what keeps "a human approved this delta"
  a checkable claim.

A second approval path would have meant re-deriving all five, and the ones it
got wrong would have been invisible from the canvas.

## What is actually new

**`getRunCheckpointReview`** (`src/app-layer/usecases/run-checkpoint-review.ts`)
— one run's status plus every `PENDING` proposal it queued, each with a diff
computed by `buildProposalDiffs` against the target's state **at read time**.
Its own module, for the reason `agent-proposal-diff.ts` is one: `agent-proposals.ts`
is the single write seam and is guarded as such, and this is the second read
that would otherwise grow it.

**`GET /api/t/:slug/agent-runs/:id/checkpoint`** — gated
`requirePermission('admin.view')`, which is a departure from its sibling
`/steps` and deliberately so. `/steps` serves the step rows the run page
already hands to the same readers, so the usecase's `assertCanRead` is right
there. A proposal **diff** is different: it carries the current values of a
risk, control, policy or finding beside what an agent proposes to change them
to, and the only surface that has ever shown those is `/agents/proposals`,
whose page gates on `admin.view` before it loads anything. The canvas is not an
admin surface. Serving the review queue from it under a weaker gate would have
been a permissions change wearing a UI feature's clothes.

**`CheckpointReviewProvider`** (`src/lib/processes/canvas-checkpoint-review.tsx`)
— the only thing joining a button inside a tldraw shape to a panel outside the
camera transform. Safe without a provider (`canReview: false`, `open` a no-op),
which is the same design property the execution overlay states for itself and
what keeps `process-shape-render` able to mount the node bare.

**`CheckpointReviewPanel`** (`src/components/processes/`) — the review surface.

## Three decisions that could have gone the other way

### `ProposalDiffPanel` moved out of the route directory

It lived in `src/app/t/[tenantSlug]/(app)/agents/proposals/`. A second reader
makes that a `route-import-boundaries` violation, and that guard exists because
`controls/` became a de-facto shared namespace and four unrelated pages ended
up rendering `controls.*` copy.

Copying the component instead would have been worse than a lint failure. Its
shape **is** a control: `approveAction` is a slot rendered from exactly one
place, inside the branch that has already rendered a diff body, so a reviewer
cannot reach the approve button without the evidence on screen. That invariant
survives only while there is one file carrying it. So the component moved, and
`agent-proposal-review-observability` now re-checks the no-disclosure-primitive
claim against **both** mounts rather than the one that existed when it was
written.

### A FLAGGED proposal is not approvable from the map

The queue allows it behind an explicit confirmation naming the rule ids. The
panel withdraws approval entirely and links there.

More friction than the queue, never less — a canvas must not be the cheaper
door to the decision the guard asked a human to look hardest at. It is also the
case where surrounding context matters most (the rule ids, the run's step, the
audit trail), and the queue has that context while a panel over a process map
does not. Same move `ProposalDiffPanel` already makes for `TARGET_MISSING` and
`PAYLOAD_UNREADABLE`: where the evidence is not all present, the control goes
away rather than being rendered beside a gap.

### Two authorities, not one

`canReviewCheckpoints` (`admin.view`) decides whether the node offers the
affordance; `canOperateCheckpoints` (`permissions.canWrite`) decides whether
the panel's buttons exist. Both resolved on the server in
`processes/page.tsx` and threaded down.

Two, because they are two on the queue, and because of what happens when they
are conflated — the proposals client records it: "Approve and Reject rendered
enabled for readers and returned 403 on press." A viewer who cannot review sees
the node exactly as it is today: a line saying a human is needed, with no
control that lies about who.

The node renders a `<button>` or a `<span>` accordingly rather than a disabled
button, because a disabled control still announces that there is something to
do here to everyone who cannot do it.

## AWAITING_APPROVAL is not a proposal count

`listWorkflowRuns` already carries the note and the filtered count that exist
because of it: a `HUMAN_CHECKPOINT` pauses a run whether or not it queued
anything, and a content-guard flag pauses one that queued nothing at all.

So the projection returns the run's status and its proposals as **separate
facts**, and an empty list on a parked run renders as a statement about the
run — with a link to the run page, where resume and abort live — never as an
empty approve queue implying the reviewer has nothing left to do.

## What the panel does not do

- **No polling.** `revalidateOnFocus` and `revalidateOnReconnect` are both off,
  which is the opposite of every other canvas read. The Run-Mode overlays exist
  to notice change nobody asked about; a diff is computed against the target's
  state at fetch time, so a background revalidation would swap the rows a
  reviewer is part-way through — and swap the `baseDigest` their next click
  sends with them.
- **No optimistic list arithmetic.** An accepted decision refetches, because
  approving the last proposal can settle the run and the panel's header is
  stale the moment a decision lands.
- **No payload.** `payloadJson` is read for the diff builder and dropped from
  the projection. The proposed value reaches the browser only as a diff
  `field`/`before`/`after` triple — structured, beside the base it would
  replace — which is the difference between reviewing an update and approving
  a blob.

## Verification

- `typecheck` EXIT=0, `lint` EXIT=0.
- `tests/rendered/checkpoint-review-panel.test.tsx` — 24 assertions; the
  load-bearing one finds the approve button **inside** `proposal-diff-<id>`'s
  subtree by containment, not merely on screen.
- `tests/rendered/process-shape-render.test.tsx` — six more, on when the run
  line is a control and when it is text.
- `tests/integration/workflow-run-steps-feed-is-bounded.test.ts` — six more,
  real DB and real RLS, including the one only a database can make: the risk is
  **edited after** the proposal was written, and both the diff and its
  `baseDigest` have to follow it.
- `tests/guards/vr6-execution-overlay.test.ts` — the no-second-path claim, as
  three reads: the panel's write target, the absence of a write usecase in it,
  and the checkpoint route's exported handlers being exactly `['GET']`.

Mutation-proved: moving the approve control out of the diff panel reddens 2;
pointing the write at a private endpoint reddens 2; dropping the `baseDigest`,
reading `AWAITING_APPROVAL` as done, allowing a FLAGGED approval, and removing
`canReview` from `open()` each redden 1.
