# 2026-08-13 — The Task naming seam, finished

**Commit:** `<sha>` `refactor(tasks): finish the rename — TaskRepository, task-status`

Completes **B3-6**. The enum half landed earlier (five enums renamed with
`@@map` pins, no migration); this is the code half — the two surfaces that
were deliberately deferred because their target names were occupied or their
files were owned by concurrent work.

## Design

Nothing about behaviour changes. Every edit is a name.

```
src/app-layer/repositories/WorkItemRepository.ts  →  TaskRepository.ts
  class WorkItemRepository                        →  class TaskRepository
  normalizeWorkItemSource()                       →  normalizeTaskSource()

src/app-layer/domain/work-item-status.ts          →  domain/task-status.ts
  checkWorkItemTransition()                       →  checkTaskTransition()
  WORK_ITEM_TRANSITIONS                           →  TASK_TRANSITIONS
  WorkItemStatusValue                             →  TaskStatusValue
  WorkItemTransitionError                         →  TaskTransitionError
  TerminalWorkItemStatus / ActiveWorkItemStatus   →  TerminalTaskStatus / ActiveTaskStatus
  TERMINAL_/ACTIVE_/ALL_WORK_ITEM_STATUSES        →  TERMINAL_/ACTIVE_/ALL_TASK_STATUSES
  REVIEW_WORK_ITEM_STATUS                         →  REVIEW_TASK_STATUS
```

~404 occurrences across 64 files. Five test files were renamed to match the
modules they exercise.

Why this could not land with the enum rename: `TaskRepository.ts` was
occupied by a dead five-line `@deprecated` re-export with zero importers,
deleted separately in B3-5 (#1877). Renaming onto an occupied filename
would have meant a delete and a move in one diff, on a file another change
was already editing.

**After this, no `WorkItem*` identifier exists in `src/` or `tests/`.** The
only surviving occurrences anywhere are the five `@@map("WorkItem*")` pins —
which are load-bearing and must never be tidied away, because they hold the
physical Postgres type names steady so the rename emitted no migration — and
prose inside historical implementation notes, which are read-only records.

### The seam test flips polarity

`tests/unit/task-repository-seam.test.ts` (added by B3-5 as
`work-item-repository-seam`) asserted that no export was named
`TaskRepository`, because at the time that name meant *the dead alias*.
After the rename `TaskRepository` is the real class, so the name that must
not come back is `WorkItemRepository`. The assertion is inverted, not
deleted: its second, stronger claim — that no two exported classes in the
repositories layer share one object identity under different names — is
untouched, and that is what actually stops a compatibility shim from
restoring the two-names state under any spelling.

## Files

| File | Role |
|---|---|
| `src/app-layer/repositories/TaskRepository.ts` | moved from `WorkItemRepository.ts`; class + `normalizeTaskSource` renamed |
| `src/app-layer/domain/task-status.ts` | moved from `work-item-status.ts`; all ten exported symbols renamed |
| `tests/unit/task-repository-seam.test.ts` | polarity inverted — now refuses a `WorkItemRepository` export |
| `tests/unit/task-status.test.ts` · `tests/unit/usecases/task-state-machine.test.ts` · `tests/guardrails/task-status-machine-wiring.test.ts` · `tests/guardrails/task-source-valid.test.ts` | renamed to match their subjects |
| `CLAUDE.md` | the B3-6 paragraph now records the rename as complete |
| `tests/guards/tasks-quickview-interaction.test.ts` | **deleted** — superseded |
| `tests/unit/rbac-guardrails.test.ts` | the two `Tasks page RBAC` regex cases removed — superseded |

## Decisions

- **Renamed the test files too.** A test named for a module that no longer
  exists is a small, permanent tax on every future grep. They were moved
  with `git mv` so history follows.
- **Did not touch the `Issue*` re-exports.** `IssueRepository.ts` binds four
  task classes to `Issue*` names and backs the `/issues` API surface. It is
  already recorded as a downward ratchet in the seam test; retiring it is a
  decision about that API, not about this rename.
- **Deleted two superseded guards rather than updating them**, and only
  after their replacement went green. `tasks-quickview-interaction` was four
  regexes over `TasksClient.tsx`, one of which was an `existsSync` on a file
  deleted long ago — always true. The two `Tasks page RBAC` cases grepped
  for `appPermissions.tasks.create` / `.edit`. Neither could distinguish
  "reads the flag" from "reads the flag and renders the button anyway";
  `tests/rendered/tasks-list-role-surface.test.tsx` mounts the page as each
  of the five roles and asserts the surface a user actually gets.
- **Left the `@@map` pins and the historical notes alone.** The pins are the
  reason the enum rename needed no migration; the notes are records of what
  was true when written, and editing them would falsify the record.
