# 2026-10-24 — Template steps reach the task, and the task page shows them

**Commit:** `<sha>` feat(tasks): template steps reach installed tasks and the task page shows them

## Design

A report that an IMDA MGF install "still had generic steps" led to three
separate defects between the authored catalogue and the screen. Each one on its
own was enough to hide every step for every framework.

```
fixture steps ──► ControlTemplateTask.stepsJson ──► install ──► Task.checklistJson ──► task page
  { text: { en } }     stored verbatim            checklistFromSteps      (never read)
                                                  read only text: string
                                                  → every step dropped
```

1. **The projection dropped every catalogue step.** `CatalogTaskSchema` steps
   are `{ text: { en, bg? }, hint?: { en, bg? } }`, and `reconcileTemplateTasks`
   stores them in `stepsJson` unchanged. `checklistFromSteps` accepted only a
   bare-string `text`, and its tests fed it only that. So from 2026-09-04 no
   task installed from any framework got a checklist, ISO 42001 included,
   where every task has steps. It now reads a locale map's `en`, which matches
   the task's scalar columns. The new tests run every authored step of every
   fixture through the projection, and they fail against the old code.
2. **Nothing displayed or toggled a checklist.** `checklistJson`, and the phase,
   evidence hint and suggested role in `metadataJson`, were written on install
   and read by no component. `<TaskChecklistPanel>` now renders them on the task
   Overview. `PATCH /tasks/:id/checklist/:itemId` (`tasks.edit`) ticks one step.
3. **MGF had no steps to show.** Its 24 tasks were authored in #2372 without
   steps. They now have 3–5 each, based on the requirement nodes in
   `src/data/libraries/imda-mgf-2026.yaml`. A step hint that names an `MGF-<n>`
   code points at the node it comes from.

Tasks installed before steps existed are reached by
`prisma/task-checklist-backfill.ts`. It runs on every container start, after
both catalogue seeders, as `dist/backfill-task-checklists.mjs`. It fills a task
only when all four hold:

- the task records its template task;
- the task is open and not deleted;
- its checklist is NULL;
- the template task is live and has steps.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/control/task-from-template.ts` | `authoredText`: reads the catalogue's locale-map step text |
| `src/app-layer/usecases/task-checklist.ts` | `toggleChecklistItem` (pure) + `setTaskChecklistItem`; `validateTaskChecklist` moved here |
| `src/app-layer/repositories/TaskRepository.ts` | `lockChecklist` (`FOR UPDATE`) + `setChecklist` |
| `src/app/api/t/[tenantSlug]/tasks/[taskId]/checklist/[itemId]/route.ts` | PATCH, `tasks.edit` |
| `src/components/controls-shared/TaskChecklistPanel.tsx` | Guidance + tickable steps; the two JSON-column readers |
| `src/app/t/[tenantSlug]/(app)/tasks/[taskId]/page.tsx` | Optimistic toggle mutation; panel on Overview |
| `prisma/fixtures/imda-mgf-control-templates.json` | Steps on all 24 tasks; corrected `_meta.grounding` |
| `prisma/task-checklist-backfill.ts`, `scripts/backfill-task-checklists.ts` | Per-start backfill |
| `scripts/entrypoint.sh`, `scripts/build-worker.mjs` | Step 1f + its bundle |

## Decisions

- **One step per request, addressed by id; never "replace the list".** A
  whole-array write would let any editor rewrite the template's step text, and
  it would need its own sanitisation path. A toggle writes no free text.
- **Row lock, not compare-and-set.** The checklist is one JSON column, so a tick
  rewrites the whole array. `FOR UPDATE` makes concurrent ticks queue. Without
  it, the integration test's three concurrent ticks lost one on every run.
  Retrying a compare-and-set would mean a read inside a loop, which the
  query-shape guardrail refuses.
- **Re-ticking changes nothing.** A step keeps its original `doneBy` and
  `doneAt`, and gets no audit row. Unticking clears both stamps, so an open step
  credits nobody.
- **`validateTaskChecklist` moved out of the schema module.** It was the module's
  only use of `@/lib/errors/types`, which imports `@/env`. The backfill bundles
  the schema module through `task-from-template.ts`, so it refused to start on
  every app variable it does not use. Its only caller is the new usecase.
- **The backfill never replaces a checklist and never touches a closed task.** A
  checklist that exists belongs to the tenant, ticked or not. Adding unticked
  steps to a finished task would report work as still to do. Deprecated
  template tasks are skipped, because that advice was withdrawn.
- **The backfill writes no audit rows.** It adds template guidance, not
  something a person did, which matches install, which writes the checklist
  without a per-task audit row. A change to an existing checklist goes through
  the toggle, which audits it.
- **Tasks installed before `templateTaskId` existed stay unreachable.** They
  cannot be told apart from hand-written tasks (see `task-from-template.ts`),
  so they get no steps. The same holds for a tenant's tasks still pointing at
  the generic five, which were deprecated when real content replaced them.
- **Three verbs were added to the actionability ratchet** (`Declare`,
  `Describe`, `Give`). MGF's titles entered its population once they had steps,
  and the file's rule is that a missing verb is a false positive and gets
  fixed there.
