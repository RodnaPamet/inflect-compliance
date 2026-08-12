# 2026-08-12 — Task vocabulary, one severity map, and tests that execute

**Commit:** `<sha>` `refactor(tasks): the subsystem is named Task; one severity map; tests that execute`

Five items from the Tasks-surface audit round, bundled because four of them
land in the same handful of files and splitting them would mean reconciling
the same diffs twice: **B3-6** (naming seam), **B2-6** (severity → badge),
**B3-4** (mutation migration), **B3-3** (retire the guard B3-4 obsoletes),
**B3-2** (executing cover for the list and the routes).

## Design

### B3-6 — the enums are renamed, the physical types are not

The aggregate has always been `Task`; a parallel `WorkItem*` vocabulary grew
up around it in the enums, the status machine and the repository. `Task` wins
on measured cost — ~1,532 occurrences against ~155 for the five enums, and
renaming the *model* would also change every Prisma accessor (`db.task` →
`db.workItem`) and the physical table name in the RLS policies.

The five enums are now `TaskStatus` / `TaskType` / `TaskSeverity` /
`TaskPriority` / `TaskSource`, each carrying `@@map("WorkItem*")`.

```
Prisma-level name          physical Postgres type
  TaskStatus      ──@@map──▶  "WorkItemStatus"     ← unchanged on disk
  TaskType        ──@@map──▶  "WorkItemType"
  TaskSeverity    ──@@map──▶  "WorkItemSeverity"
  TaskPriority    ──@@map──▶  "WorkItemPriority"
  TaskSource      ──@@map──▶  "WorkItemSource"
```

**The `@@map` is load-bearing, not cosmetic.** Drop it and `prisma migrate
dev` emits `ALTER TYPE "WorkItemStatus" RENAME TO "TaskStatus"` ×5. The rename
is metadata-only and instant, which is exactly what makes it tempting — but
Prisma emits *explicit enum casts* (`$1::"WorkItemStatus"`) in generated SQL.
During a rolling deploy the still-running old image would cast to a type that
no longer exists and every task read and write would fail with SQLSTATE 42704
until the last old container drained. So the rename emitted **no migration at
all**; the only artefact is `tests/integration/task-enum-db-mapping.test.ts`,
which fails if either half of the pin breaks — the Prisma name drifting back,
or the `@@map` being tidied away.

### B2-6 — one severity map, and it says HIGH is red

`TASK_SEVERITY_VARIANT` in `entity-status-mapping.ts` is now the only
severity → tone decision for tasks. `TasksClient` and `LinkedTasksPanel` each
carried a private copy, and the three disagreed:

| | INFO | LOW | MEDIUM | HIGH | CRITICAL |
|---|---|---|---|---|---|
| `TASK_SEVERITY_VARIANT` (was) | neutral | info | warning | **warning** | error |
| `TasksClient` (was) | neutral | **neutral** | warning | **error** | error |
| `LinkedTasksPanel` (was) | neutral | **neutral** | warning | **error** | error |
| **now — all three** | neutral | info | warning | **error** | error |

The same task rendered HIGH red in the list and amber on its own detail page,
and LOW grey in the list and blue on detail.

The canonical map moved to `HIGH: 'error'` rather than dragging the other two
back to `'warning'`. That is the repo-wide convention — `FindingsClient`,
`VulnerabilitiesClient`, `SecurityTestingClient` and `VENDOR_CRITICALITY_VARIANT`
all use it — and it matters here specifically because `TaskType.AUDIT_FINDING`
tasks materialise *from* findings (`Task.findingId`), so a finding and its own
remediation task must not disagree about what HIGH looks like. It is also the
better collapse: `HIGH: 'warning'` merged MEDIUM and HIGH into one tone, which
is the boundary users actually triage on, where grouping HIGH with CRITICAL
merges the two that share a response ("escalate now").

### B3-4 / B3-3 — the mutation migration, and the guard it obsoletes

The task detail page had eleven hand-rolled `fetch` mutations, each repeating
the `res.ok` check, the toast, and the cache invalidation. They now go through
`useTenantMutation`, with the response gate factored into `okOrThrow` and the
cross-key invalidation into `invalidateTaskLists`.

That migration is what forced B3-3. `tests/guards/task-mutation-error-handling.test.ts`
listed eight handler *names* and asserted each body matched
`if (!<name>Res.ok)` plus a `toast.error`/`throw`. Seven of its sixteen
assertions went red against code that surfaces failures strictly better than
before — it pinned a spelling, not a behaviour. Worse, it never executed the
page, so it would have stayed green through a handler that read `res.ok` and
then did nothing with the answer.

The detail-page half is retired and replaced by
`tests/rendered/task-detail-mutation-failures.test.tsx`, which mounts the real
page against a stubbed `fetch` and asserts the user-visible contract: a
rejected write surfaces **the server's own reason**, a rejected comment does
not clear the box, and a successful write revalidates the list and KPI caches
this page never reads.

Two parts of the old guard survive, because they are genuinely structural and
no rendered test covers them cheaply: the empty-`.catch` swallow scan (a
whole-file check, immune to handler-shape churn) and the create-form's
pending-link contract, whose file B3-4 did not touch.

### B3-2 — the list and the routes, executed

`TasksClient` was the third page found with the ControlsClient / AuditsClient
shape: a large client island fenced by ~22 files that read its *source* and
one rendered test that drives it. Source readers cannot fail on a bulk action
offered to a READER, a quick-view that opens but never switches, or a severity
badge contradicting the detail page — all three spellings look identical in
the file.

The routes had the same problem from the other direction:
`tests/guards/tenant-crud-authz-coverage.test.ts` covers two of the seventeen
`/api/t/[tenantSlug]/tasks/**` routes, and covers them by grepping for
`requirePermission('tasks.edit'`. That passes on a route whose gate names a
permission every role holds, on a route that gates GET and forgets DELETE, and
on a route whose import survived a refactor that dropped the wrapper. Fifteen
routes — the four bulk mutations among them — it never looked at.

## Files

| File | Role |
|---|---|
| `prisma/schema/enums.prisma` | the five enums renamed, each `@@map`-pinned |
| `prisma/schema/tasks.prisma` | `Task`'s five enum-typed columns follow the rename |
| `src/app-layer/domain/entity-status-mapping.ts` | `TASK_SEVERITY_VARIANT` becomes the one map; `HIGH` → `error` |
| `src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx` | private `SEVERITY_BADGE` deleted, imports the shared map |
| `src/components/LinkedTasksPanel.tsx` | same, plus shared severity labels |
| `src/app/t/[tenantSlug]/(app)/tasks/[taskId]/page.tsx` | eleven mutations → `useTenantMutation` + `okOrThrow` |
| `src/app-layer/repositories/WorkItemRepository.ts` | enum-name sweep only — the file rename is a separate step |
| `src/app-layer/domain/work-item-status.ts` | enum-name sweep only — 27 importers, renamed separately |
| `tests/integration/task-enum-db-mapping.test.ts` | fails if either half of the `@@map` pin breaks |
| `tests/rendered/task-detail-mutation-failures.test.tsx` | behavioural replacement for the retired guard half |
| `tests/rendered/tasks-list-role-surface.test.tsx` | mounts `TasksClient` — role surface, quick view, badge tone |
| `tests/unit/tasks-routes-authz.test.ts` | all seventeen tasks routes executed under a refused role |
| `tests/guards/task-mutation-error-handling.test.ts` | detail-page shape half retired; swallow scan + create-form half kept |
| `CLAUDE.md` | documents the naming decision and why the `@@map` must stay |

## Decisions

- **Renamed the enums, not the model.** A 10× cost difference, and the model
  rename would reach the physical table name that the RLS policies address.
- **`@@map` over `ALTER TYPE`.** A metadata-only rename is still a
  rolling-deploy outage when the client emits explicit casts. Pinning costs
  five comments; the alternative costs every task read for the length of a
  deploy.
- **Left two `WorkItem*` surfaces alone in this diff.** `WorkItemRepository`
  (243 occurrences / 43 files) and `domain/work-item-status.ts` (27 importers)
  are pure `sed` + file move, and the target filename `TaskRepository.ts` was
  occupied by a dead re-export until #1877 deleted it. Keeping the mechanical
  rename out of a diff that also changes behaviour keeps this one reviewable.
- **Moved the canonical severity map to the callers' value, not the reverse.**
  Two of the three copies already said `HIGH: 'error'`, it matches every other
  severity surface in the repo, and it collapses the pair that shares a
  response instead of the pair users triage between.
- **Deleted a guard rather than repairing it.** The repaired version would
  have asserted `okOrThrow(res, …)` instead of `if (!res.ok)` — the same
  spelling pin one refactor later. The regression class it was reaching for is
  real, so it was replaced with a test that mounts the page, not retired
  outright.
- **Kept the create-form half of that guard untouched.** B3-4 did not migrate
  `useNewTaskForm.ts`, and its partial-success contract (never `throw` on the
  path where the task was already created, or the modal traps the user over a
  submittable form and a second press mints a duplicate) is still only
  expressed there.
