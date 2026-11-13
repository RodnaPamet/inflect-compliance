# 2026-11-13 — External-write reconcile: real task author, rotating batches

**Commit:** `fix(external-write): grant-expiry task as a real user; reconcile batches rotate` (#5491; issues #5255, #5259)

## Design

Two passes in `usecases/external-write-reconcile.ts` read a bounded batch of
`ExternalWriteJournal` rows each run: the ACCEPTED-delivery reconcile and the
grant-expiry sweep.

- **Rotation (#5259).** A new nullable `lastCheckedAt` records a visit. Each
  pass reads `orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, <age>]`
  and stamps every row it read in one `updateMany` straight after the read. A
  row that can never progress (deleted connection, unparseable end date, grant
  already escalated, unverifiable answer) now moves behind the rest instead of
  holding the batch every pass. Index `[tenantId, outcome, lastCheckedAt]`.
- **Escalation author (#5255).** The "grant outlived its window" task is created
  as the tenant's system user (`buildTenantSystemJobContext`), built lazily once
  per pass. The pass's own `buildSystemContext` names `system`, which is no
  `User`, so the NOT NULL `createdByUserId` refused every insert. Each raise is
  wrapped per row: a failure counts as `raiseFailed`, the row stays unescalated,
  and the next pass asks again.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma` | `lastCheckedAt` column + index |
| `prisma/migrations/20261113060000_external_write_journal_last_checked/` | additive migration |
| `src/app-layer/usecases/external-write-reconcile.ts` | rotation order, `stampVisited`, system-user task, per-row catch |
| `src/app-layer/jobs/external-write-dispatch.ts` | sums `raiseFailed` |

## Decisions

- **Stamp at read, not at outcome.** Stamping right after the read means a pass
  that dies midway still rotates; stamping per outcome would leave the rows a
  crash interrupted at the front again.
- **A visit column, not a stored end date.** The issue's first option was to
  store the end date so SQL could filter not-yet-due rows. That needs a backfill
  from encrypted `argumentsJson` and answers only the expiry pass; a visit stamp
  answers both passes with an additive, unbackfilled column.
- **Connection-gone rows are not settled here.** They rotate now, so they no
  longer starve the batch, but they still count `unreadable`. Giving them a
  terminal outcome is a separate decision about what the journal should say.
