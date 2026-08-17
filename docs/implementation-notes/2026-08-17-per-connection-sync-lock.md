# 2026-08-17 — One sync at a time per connection

**PR:** #TBD — fix(integrations): one sync at a time per connection

## Design

H2-3 was scoped as a concurrency guard "with a reaper". Before building it I
checked whether concurrent same-connection runs were actually reachable, since a
migration for a theoretical risk is not worth it. They are, and the consequence
is data corruption rather than wasted work.

### The reachable path

`POST /api/t/:slug/integrations/sharepoint/sync` enqueues a delta sync with **no
job id**, on the default 60/min mutation tier. Double-clicking "Sync now" is
enough. The scheduled dispatcher gained a deterministic id in the previous PR,
but that id does not cover this route, so manual-vs-manual and
manual-vs-scheduled were both unguarded.

### Why concurrency corrupts here

Two things in the SharePoint delta importer are not concurrency-safe:

- `readDeltaTokens` / `writeDeltaTokens` are a read-modify-write of
  `configJson` in **separate transactions**, so two runs both start from the
  same token and both replay the same change set.
- `importOne` **always** calls `uploadEvidenceFile`, creating a new Evidence
  row. Only the *mapping* is upserted.

So the same SharePoint file becomes **two Evidence rows and one mapping**. The
copy that lost the mapping race is orphaned: a real Evidence record in the
compliance system with no provenance back to the drive it came from. In a
compliance product that is a document an auditor sees twice, and the untraceable
copy is the one that raises questions.

`identity-sync` has a quieter version. Two overlapping runs compute their `seen`
sets independently, and the deprovision reconcile from the run that started
earlier (`updateMany … externalUserId: { notIn: seen }`) can flip accounts the
later run just upserted to `DEPROVISIONED` — the wrongful-mass-deprovision
hazard the truncation guard already worries about, through a different door.

### The lock

```
acquire ──▶ UPDATE … WHERE id = ? AND (syncLockedAt IS NULL
                                       OR syncLockedAt < now - TTL)
                     SET syncLockedAt = now, syncLockToken = <uuid>
            count === 1 ? token : null

release ──▶ UPDATE … WHERE id = ? AND syncLockToken = <token>
                     SET syncLockedAt = NULL, syncLockToken = NULL
```

One conditional `UPDATE`, so the check and the claim are a single atomic
statement — a read-then-write would leave exactly the race being closed.

**The reaper is the acquire predicate.** A separate sweeper job has a window
between "lock went stale" and "sweeper ran" during which the connection is still
wedged, and it is one more scheduled thing that can fail silently. Folding the
reap into acquire removes both problems: the lock is reaped exactly when someone
wants it, by the process that wants it.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/automation.prisma` + migration | `syncLockedAt`, `syncLockToken`. Additive, nullable, no backfill. |
| `src/app-layer/integrations/connection-lock.ts` | New. `acquireSyncLock` / `releaseSyncLock` + the TTL. |
| `src/app-layer/jobs/sharepoint-delta-sync.ts` | Lock around the delta sync; `finally` release. |
| `src/app-layer/jobs/identity-sync.ts` | Same, around the reconcile-bearing sync. |
| `src/app/api/.../sharepoint/sync/route.ts` | Minute-bucketed `jobId` — collapses the double-click. |
| `src/app-layer/integrations/providers/sharepoint/import.ts` | `skipped?` on the existing result shape. |

## Decisions

- **A lease, not a lock, and the TTL is a real tradeoff.** A lease can be stolen
  from a holder that is merely SLOW rather than dead, and then two runs proceed
  anyway — inherent to lease-based locking, not a bug here. 30 minutes sits well
  above any plausible run (the longest is a 5000-account enumeration at a 120 s
  per-page budget) and well below the tightest schedule interval (4 h), so a
  connection wedged by a killed worker self-heals before its next scheduled run.

- **Release is token-matched.** If a run overran its lease and another took the
  lock, clearing unconditionally would unlock the connection *while the new
  holder is still running* — turning one overlap into an unbounded number. The
  failed release logs a warning, because it means a sync exceeded the TTL and
  that is worth seeing.

- **A skip is `SKIPPED`, not `PASSED`.** Both are job successes under the
  `status !== 'ERROR'` mapping, but claiming a sync passed when it never ran
  would make the lock invisible in exactly the logs someone would check to find
  out why data looks stale.

- **The manual route gets a MINUTE bucket, not the dispatcher's 4 h one.** An
  operator who fixes a permission and clicks again must get a real run, not a
  silent dedupe against their own last click. The lock is the backstop that
  makes manual and scheduled runs safe against each other; the id only collapses
  the double-click.

- **Posture collectors are deliberately not locked.** Their writes are
  control-keyed upserts, so a concurrent run duplicates work without duplicating
  records. Locking them would be consistent-looking but would buy nothing and
  add a failure mode.
