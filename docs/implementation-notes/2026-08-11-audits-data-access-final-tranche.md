# 2026-08-11 — Audits: the last data-access tranche, and the files that stay on `fetch`

**Commit:** `<pending>` refactor(audits): close the data-access migration's remaining list

Closes the "Remaining" list from
[2026-08-10-audits-data-access.md](2026-08-10-audits-data-access.md). Six files
move onto `useTenantSWR` / `useTenantMutation`; the seventh is recorded as a
deliberate non-target with its reason in the source. The audits surface started
this migration with 30 raw `fetch` writes and zero `useTenantMutation`.

One file the original list did not name turned up while checking that claim —
`EditAuditModal` — and it is left for a follow-up rather than folded in here.
See "Remaining" at the bottom.

## Design

### The keys are the load-bearing part

Every read and every write in this tranche derives its cache key from
`CACHE_KEYS`. That is not tidiness — it is the one property that makes the
migration mean anything. A mutation keyed on a near-miss string does not throw:
it optimistically updates an entry nobody renders, revalidates nothing, and the
UI simply waits for the next natural refetch. That is indistinguishable from a
slow network, which is why it survives review. Deriving both sides from one
function removes the failure mode rather than documenting it.

Two consequences showed up while doing it:

- **`audits.businessContinuity()` and `audits.bia(id)` were wrong.** Both
  carried an `/audits` prefix, because that is where the *screen* lives
  (`/t/{slug}/audits/business-continuity`). The *API* route is
  `/api/t/{slug}/business-continuity` — no `/audits` segment. As written, a read
  would 404 and a mutation would target an entry nothing renders. No caller had
  exercised them yet, so the correction is behaviour-preserving; it is pinned by
  a test in `tests/unit/swr-keys.test.ts` so the nav path cannot be pasted back
  over the API path.
- **The gap-assessment delegation keys live outside `audits`.** The assignment
  feed is `/gap-assessments/{id}/assignments` and the respondent's bucket is
  `/gap-assignments/{id}`. Grouping them under `audits` would have produced
  exactly the lie above, so they get their own registry entries.

`nis2GapRemediations(minCriticality)` carries the criticality floor in the key,
for the same reason `dashboard.trends(days)` does: the floor is a *server-side*
filter, so a mutation keyed on the bare path would target an entry the page
never reads.

### Not one of these writes gets an optimistic prediction

Every mutation in this tranche declines `optimisticUpdate`, and each declines
for its own reason — worth stating, because the platform hook exists *for*
optimistic UI and "no prediction anywhere" would otherwise read as cargo cult:

| Write | Why waiting is the honest answer |
| --- | --- |
| create finding / create audit / create cycle | The server mints the id, the status, the timestamps — and for a cycle, the readiness ring the card renders. A guessed row shifts on revalidation. |
| NIS2 re-run | Mints a whole new assessment; every number on the page is recomputed from it. |
| apply remediations | The server decides what each approval becomes and which it **skips** as already-existing. The counts in the success notice are the outcome, not the input. |
| dispatch / finalize assignments | Dispatch mints one row per role with a server-computed question split; finalize recomputes the run. |
| SharePoint export | The item id, its webUrl and the per-reason skip counts are minted while the ZIP is built and uploaded. Guessing them is a claim about what SharePoint accepted. |
| respondent submit | The `SUBMITTED` flip **is** derivable — and predicting it is still wrong. See below. |

The submit case is the interesting one. Its status flip is set unconditionally
by the usecase on success, so an optimistic update would be accurate whenever
the request succeeds. But the submit button's render is gated on that field, so
painting it would unmount the button mid-flight, take the spinner with it, and
show the page's TERMINAL state over a request that can genuinely fail — an
out-of-bucket question id is a 403 at the data layer. A respondent who reads
"already submitted" and navigates away in that second never sees the rollback.
The cycle-status control (previous tranche) predicts precisely because its
control stays on screen either way.

### Focus revalidation is a new hazard, and two files had to answer it

The hand-rolled loaders fetched **once**. `useTenantSWR` also revalidates on
window focus, which turns any "seed state from the payload" effect into a
clobber of whatever the user has typed since.

- `RespondClient` no longer seeds an `answers` state. Saved answers are the
  baseline, `edits` holds only what this session changed, and the rendered map
  is the two merged — a derivation that cannot be clobbered.
- `Nis2AssignmentsPanel` keeps its `picks` state (the pickers are controlled),
  but syncs it on the *serialized* saved mapping, so an unchanged server answer
  on a focus revalidation does not overwrite a pick the owner is mid-way through
  making.

### What stays on raw `fetch`, and why that is the right call

Three writes in `business-continuity/` are **not** migrated. All three sit
behind server components: `page.tsx` calls `listBias(ctx)` and passes
`initialRows` down; the BIA detail page passes `bia` as a prop and every write
ends in `router.refresh()`. There is no client cache entry to update, so a
mutation hook would compute an optimistic update against an empty entry, do
nothing, and still depend on `router.refresh()` for the actual refresh —
ceremony with no rollback benefit.

`NewBiaModal` is the sharpest instance: its create navigates to the new BIA's
server-rendered detail page, so even a *correct* prediction would paint a list
that unmounts a tick later. The reason now lives in the file's docblock, next to
the code someone would otherwise "fix", along with the condition that would make
it a genuine target (the register moving onto `useTenantSWR`).

`BiaLinkControlModal` is a split decision and worth noting as such: its **read**
migrated (the picker's options are the shared `/controls` list — a real cache
entry, shared with every other consumer) while its **write** stayed inline for
the reason above. The read migration also fixed a live bug: the hand-rolled
reader accepted a bare array or a `{ controls }` wrapper, and the route returns
neither — it returns the backfill-capped `{ rows, truncated }` envelope. The
picker silently rendered **zero options on a perfectly successful load**. That is
the exact failure `unwrapCappedList` exists for.

## Files

| File | Role |
| --- | --- |
| `src/lib/swr-keys.ts` | `readinessOverview`, `nis2GapRemediations`, `gapAssessments`, `gapAssignments`, `integrations.sharepointConnections`; BIA keys corrected to the API path |
| `src/app/t/…/audits/cycles/page.tsx` | 2 reads → SWR, create → mutation; `navigating` latch keeps the button disabled through the post-create push |
| `src/app/t/…/audits/nis2-gap/Nis2GapLifecycleClient.tsx` | 2 reads → SWR, 3 writes → mutations, 4 hand-rolled requests → one `send` helper |
| `src/app/t/…/audits/nis2-gap/respond/[assignmentId]/RespondClient.tsx` | read → SWR, submit → mutation; answers become saved+edits merge |
| `src/app/t/…/audits/packs/[packId]/SharePointExportButton.tsx` | connection probe → shared SWR key, export → mutation; the probe's tri-state preserved exactly |
| `src/app/t/…/audits/NewFindingModal.tsx` | create → mutation; also fixes an `[object Object]` error banner |
| `src/app/t/…/audits/_form/useNewAuditForm.ts` | create → mutation underneath `useZodForm` |
| `src/app/t/…/audits/business-continuity/[id]/BiaLinkControlModal.tsx` | read → SWR (fixes the empty picker); write stays inline, with reason |
| `src/app/t/…/audits/business-continuity/NewBiaModal.tsx` | non-target, reason recorded in the docblock |

## Decisions

- **The `send` helper takes `preferServerMessage` as an argument rather than
  being copied twice.** The lifecycle page and the delegation panel genuinely
  disagree about which message the user sees: the assignments endpoints return
  an actionable server message ("run already finalized", "not every respondent
  has submitted") that the panel has always surfaced, while the nis2-gap writes
  have always shown their own localized fallback. Making that an argument keeps
  the disagreement deliberate; a second copy of the request would let it drift
  into an accident.

- **`NewFindingModal` does not invalidate the audits list**, even though the
  list's `_count.findings` is stale after a create. Only the parent knows
  whether the live key is `/audits` or the cycle-scoped `/audits?cycleId=…`, and
  its existing `onCreated` already revalidates the right one. Naming the bare key
  here would duplicate one case and miss the other.

- **The cycles page keeps a `navigating` latch beside `isMutating`.**
  `isMutating` flips back to `false` the moment the response lands, but the flow
  then pushes to the new cycle — re-enabling the submit button mid-navigation
  would re-open the double-submit the original guard closed.

- **`useNewAuditForm` re-throws from `mutationFn`, so `useZodForm` surfaces the
  same string from the same place as before.** The migration is invisible to
  `#new-audit-error`.

- **Every "is this an error?" check reads `error && !data`, not `error`.** This
  is the one class of mistake the migration introduces by construction, and the
  first draft of this tranche made it twice. The loaders being replaced ran
  **once on mount**; `useTenantSWR` revalidates on focus and on reconnect, and
  SWR keeps the cached data when a revalidation fails. So `Boolean(query.error)`
  — which is a faithful translation of the old code — means something new: a
  tab-away-and-back across a blip sets `error` while `data` is still good and
  `isLoading` is false. On the cycles page that replaced a fully-rendered list
  (and an open create-cycle modal) with the Retry empty state; on the SharePoint
  button an error-first ternary unmounted an export control whose `connId` was
  still valid, discarding an in-progress folder selection. Both now gate on the
  absence of data, which confines the error branch to the cold start it was
  written for. `TasksClient` had already reached the same conclusion.

- **The SharePoint probe still reads `false` on a failed COLD start.** With no
  connection id there is no export destination, so offering the button would
  only produce a picker that cannot open. That reasoning is sound — it is just
  specific to the first load, which is why the tri-state is ordered data-first.

- **The assignments read opts out of retry.** `GET /gap-assessments/{id}/
  assignments` is gated on `admin.manage` while the panel renders on `canWrite`,
  so an EDITOR's read is a 403. A denial is not a transient condition, and the
  hook's default `errorRetryCount: 2` would turn one swallowed 403 per visit
  into three — each writing an immutable `AUTHZ_DENIED` row. Focus revalidation
  stays on, because for the admins the panel is actually for, respondent status
  is exactly the kind of out-of-band change it exists to catch.

## Remaining

**`EditAuditModal.tsx` — one write, two reads, and it was never on the original
list.** Auditing the surface to confirm this tranche closed it turned up a file
the 2026-08-10 note's thirteen did not include. It is a genuine target, not
another server-fed exclusion: it is mounted inside `AuditsClient`, which *is*
client-cached (`useTenantSWR` on the audits list).

What is there:

- Its two catalogue reads (`/frameworks`, `/audits/cycles`) duplicate paths that
  already have registry entries — `CACHE_KEYS.frameworks.list()` and
  `CACHE_KEYS.audits.cycles()` — and are now read through SWR by the cycles page
  and `AuditsClient` respectively. Converting them (with a null key while the
  modal is closed, preserving the `if (!open) return` gate) makes three
  components share two cache entries instead of issuing their own GETs.
- Its `PUT /audits/{id}` is the **same request `AuditsClient` already models** as
  the `auditWrite` mutation, keyed on the cycle-scoped audits list. So this is
  not "migrate one more write" — it is the *third* caller of one PUT, which is
  the shape the previous tranche already resolved for `updateChecklist` /
  `updateAuditStatus`. The likely move is for the modal to take a `save(body)`
  prop and for `AuditsClient` to wire it to `auditWrite.trigger`, deleting the
  duplicate request rather than converting it.

It is deliberately **not** folded into this PR: the fix changes the component's
props contract, and `EditAuditModal` currently has no test coverage of any kind
(no test file references it or its `#edit-audit-save` control). A props change
to an untested modal wants its own diff and its own rendered test — the repo's
own worked example of why is the Assets status control, where a guard asserted
the schema mentioned `status` while the control persisted nothing for months.

**`Nis2AssignmentsPanel` is gated on the wrong permission.** The panel — and its
dispatch and finalize buttons — render on `canWrite`, but every endpoint behind
them is `requirePermission('admin.manage')`. An EDITOR therefore sees a control
surface where each action 403s, and merely opening the page writes an
`AUTHZ_DENIED` row. This predates the migration, so only the amplification it
caused is fixed here (see the retry decision above). The real fix is to pass an
admin flag from `nis2-gap/page.tsx` and gate on it, which removes the failing
read entirely rather than making it cheaper.

**The `error && !data` guard is a series-wide question, not a per-file one.** The
same `Boolean(query.error)` shape shipped in the previous tranche and is on
`main` today at `packs/[packId]/page.tsx` and `cycles/[cycleId]/page.tsx`. Those
are out of this diff's scope but have the same failure mode, and the convention
belongs in the data-access guidance rather than being rediscovered per page.
