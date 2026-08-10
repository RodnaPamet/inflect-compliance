# 2026-08-10 — Audits: data-access conventions and the execution-flow coverage gap

**Commit:** `<pending>` refactor(audits): start the data-access migration, test the checklist execution flow, tenant-assert the pack export

The Audits surface had not started the platform's data-access migration: 30 raw
`fetch` writes, **zero** `useTenantMutation`, and three `useTenantSWR` reads
across 34 files. Every write re-decided its own error handling, cache
invalidation and rollback. This lands the first tranche, closes the coverage gap
on the core workflow, and clears the smaller residuals.

## Design

### The precondition was already met

The brief asked for `OptimisticUpdater` to be widened to `TData | undefined`
*before* the migration, so 30 new call sites would not inherit the `as unknown
as` casts the Controls sites needed. **That already landed** in PR #1812 — the
type is `(current: TData | undefined, input: TInput) => TData | undefined`, and
its docstring records the two casts it removed. Nothing to do; the migration
below writes `current && {...}` throughout and needs no casts.

### Pack detail — the largest single conversion

Seven POSTs and three hand-rolled read triples. The reads became three SWR keys;
the writes became seven `useTenantMutation` calls sharing one `postJson` helper.

Two decisions worth recording:

- **The keys are named in `CACHE_KEYS`, not spelled inline.** A mutation keyed
  on a near-miss string does not error — it optimistically updates nothing and
  the UI simply waits for revalidation, which is indistinguishable from a slow
  network. Deriving both sides from one function removes the failure mode.
- **Not every write gets an optimistic prediction.** `freeze` does, because the
  whole page re-chromes on FROZEN and a failed freeze previously left the badge
  claiming a state the server had refused. `materialize` does not, because the
  server mints a Finding and a Task whose shape is not derivable client-side —
  the honest answer there is to wait, not to paint a guess. `clone` is keyed on
  the pack LIST, not this pack's detail, because it mints a new pack and keying
  it on the open pack would corrupt what the user is looking at.

### The audits hub — one PUT, two callers

`updateChecklist` and `updateAuditStatus` hit the same endpoint with different
bodies and each hand-rolled the request, the `res.ok` branch, the error toast,
and (for status) a manual snapshot/restore.

The detail pane is component state, not an SWR entry — it holds ONE audit chosen
by click, which is not a cache key. So `useTenantMutation` owns the request
lifecycle and the LIST invalidation while the pane's optimistic flip stays local.
Making the pane a cache entry would buy a rollback that already exists and cost a
key nothing reads.

### What is deliberately NOT migrated, and why

`BiaDetailClient` is **server-component-fed**: `bia` arrives as a prop and every
write ends in `router.refresh()`. It has no client cache, so a `useTenantMutation`
there would compute an optimistic update against an empty entry, do nothing, and
still depend on `router.refresh()` for the actual refresh — ceremony with no
rollback benefit. The convention is right for client-cached pages; this is not
one. Recorded rather than forced.

The remaining client-fetching files (`cycles/page.tsx`,
`cycles/[cycleId]/page.tsx`, `nis2-gap/Nis2GapLifecycleClient.tsx`, the auditors
admin page, and the five single-write modals) are genuine targets and are not
done here — see "Remaining" below.

### The checklist execution flow now executes in a test

`AuditsClient.tsx` carried 18 structural ratchets and no test that ran it. Its
exclusion from the DataTable ratchet is deliberate and documented; the gap was
that the flow an auditor performs — open an audit, record PASS/FAIL, move the
status — was described structurally and never exercised.

That distinction has teeth here: the Assets status control is the repo's worked
example of a guard asserting a schema *mentions* `status` while the control
persisted nothing for months. The new suite drives the component and reads what
reached the wire, and its load-bearing case is the failure one — a PUT that fails
must not leave the row looking saved, because an auditor who sees PASS on screen
and NOT_TESTED in the database discovers it mid-audit.

### The pack export's missing tenant assertion

`audit-pack-sharepoint-export.ts` read `provider.readStream(f.pathKey)` without
the `assertTenantKey` its sibling `audit-hardening.ts` applies to an identically
sourced key. Not a live vulnerability — both queries producing those rows filter
`tenantId` — but the inconsistency was the finding.

Added, with one adaptation: the shared helper *throws*, which is right for a
single-file read where there is nothing to salvage. Here one bad row must not
abort an export of hundreds of good ones, so it is wrapped as a predicate and a
failure becomes a counted skip. It gets its **own** reason rather than folding
into `unreadable`, because the two mean opposite things to an operator — one is
a storage problem, the other a data-integrity one, and merging them is exactly
the blur that made a single `skipped` count useless.

## Files

| File | Role |
| --- | --- |
| `src/lib/swr-keys.ts` | audit keys for pack detail, shares, share-comments, cycles, BIA, auditors |
| `src/app/t/…/audits/packs/[packId]/page.tsx` | 3 reads → SWR, 7 writes → `useTenantMutation` |
| `src/app/t/…/audits/AuditsClient.tsx` | both writes → one `auditWrite` mutation |
| `src/app-layer/usecases/audit-pack-sharepoint-export.ts` | `assertTenantKey` as a counted skip + `foreignKey` reason |
| `src/app-layer/usecases/audit.ts` | `createAudit` takes `z.infer<typeof CreateAuditSchema>` |
| `src/app/api/audit/shared/[token]/route.ts` | per-token rate limit on the public POST |
| `docs/audits-surface-do-not-touch.md` | the five verified-correct findings |
| `tests/rendered/audits-checklist-execution.test.tsx` | the execution flow, executing |

## Decisions

- **`createAudit` derives its parameter from its schema.** A hand-written twin
  drifts in one direction and silently: a field the schema strips but the twin
  declares is never populated at runtime while the types insist it will be. The
  fix was already in this file, applied to `updateAudit` — the pair just
  disagreed.

- **The public share POST is rate-limited per token.** It relied on the default
  mutation limit, which is keyed `(IP, userId)` — and `userId` is null for every
  caller here, because nobody is authenticated. So the whole unauthenticated
  internet shared one bucket per IP across every share link. The GET already
  carried per-token scope with a written rationale; this applies the same
  reasoning to the side that writes.

- **Partial migration, stated as partial.** Two of thirteen files are done
  (nine of the thirty writes). Shipping the pattern plus the two highest-traffic
  files, with the remainder named, beats a rushed sweep across thirteen files
  whose optimistic-update semantics each need a decision.

## Remaining

Not done here, in the brief's own priority order:
`business-continuity/[id]/BiaDetailClient.tsx` (4 — excluded above, with reason),
`auditors/page.tsx` (4), `nis2-gap/Nis2GapLifecycleClient.tsx` (3),
`cycles/[cycleId]/page.tsx` (3), `cycles/page.tsx`, `NewFindingModal`,
`NewBiaModal`, `BiaLinkControlModal`, `_form/useNewAuditForm`,
`SharePointExportButton`, `nis2-gap/respond/[assignmentId]/RespondClient` (1 each).
