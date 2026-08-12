# 2026-08-11 — the reviewer sign-off gate gets a discovery surface

**Commit:** `(pending) fix(tasks): tell the reviewer, and let them find the queue`

## Design

The four-eyes control (`checkReviewerSignOffGate`, TP-2) works: a task
carrying a `reviewerUserId` can only reach RESOLVED/CLOSED from IN_REVIEW,
and only by that one named reviewer — on both the single-task and the bulk
status paths. The control was complete and the work it created was
invisible. Nothing notified the reviewer when a task entered IN_REVIEW
(watcher fan-out reaches `TaskWatcher` rows only, and nothing subscribes a
reviewer), and the list page had no way to ask "what is waiting on my
sign-off?" — `reviewerUserId` was not a filter, not a column, not a metric.

Two halves, one per gap.

**The bell.** A new `NotificationType.TASK_REVIEW_REQUESTED`, raised on the
transition INTO IN_REVIEW and routed to the reviewer alone. The emission
hangs off `afterTaskStatusCommit` — the shared post-commit sequence #1868
introduced — so single and bulk cannot diverge: a step added here exists for
both, or for neither. It sits post-commit, beside the other bells, for the
reason that comment already gives: a notification failure must never roll a
committed status change back, and a rolled-back transaction must never leave
a bell pointing at a change that did not happen. The recipient set is
deliberately a single person: watchers already get the generic
`status_changed` activity entry, and widening this one would turn a
"you specifically are blocking this" message into noise.

`TaskStatusChange` carries `reviewerUserId` so neither path pays a query for
it — the single path has it from its pre-fetch, the bulk path from the
batched `listByIds` the gate needs anyway.

**The queue.** A new `awaitingReviewBy=<userId>` list filter, meaning
IN_REVIEW *and* reviewed by that user, pushed onto the `where`'s `AND` so it
composes with an explicit status selection rather than clobbering it. It
carries the user id explicitly rather than resolving "me" from `ctx.userId`
server-side, because `listTasks` caches on filter params alone — an implicit
"me" would hand two users in one tenant the same cache key and two different
correct answers. On the page it is a toggle beside "Assigned to me", built
the same way: one `filterCtx.set(key, currentUserId)` flowing through the
same filter state, URL sync and query. It carries a real filter-defs entry
whose options are supplied at render — exactly one, "Me". The first cut
registered the key WITHOUT a def, on the reasoning that a picker with one
option is furniture; the toolbar disagreed out loud (`Filter.List received
an activeFilter without a corresponding filter`), because an active value
with no def is a chip nothing can label. The def is what makes the facet
legible in the chip row and the filter dropdown, which is the same
discoverability problem this change is about.

## Files

| File | Role |
|---|---|
| `prisma/schema/enums.prisma` | `TASK_REVIEW_REQUESTED` notification type |
| `prisma/migrations/20260811120000_notification_task_review_requested/` | `ALTER TYPE … ADD VALUE IF NOT EXISTS` |
| `src/app-layer/notifications/assignment.ts` | the new kind + its copy and deep link |
| `src/app-layer/usecases/task.ts` | `reviewerUserId` on `TaskStatusChange`; `emitTaskReviewRequestedNotifications` in the shared post-commit sequence |
| `src/app-layer/domain/work-item-status.ts` | `REVIEW_WORK_ITEM_STATUS` — one definition for the three surfaces keyed to IN_REVIEW |
| `src/app-layer/repositories/WorkItemRepository.ts` | `awaitingReviewBy` filter |
| `src/app/api/t/[tenantSlug]/tasks/route.ts` | query param → all three list branches |
| `src/app/t/[tenantSlug]/(app)/tasks/page.tsx` | deep-link whitelist |
| `src/app/t/[tenantSlug]/(app)/tasks/filter-defs.ts` | the facet's def + `AWAITING_REVIEW_FILTER_KEY` + its render-time option |
| `src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx` | the toggle |
| `messages/{en,bg}.json` | label + tooltip |

## Decisions

- **Emission in the shared sequence, not at either call site.** The bulk
  path had already lost three steps this way once (B1-4). Hanging the bell
  off `afterTaskStatusCommit` makes the "single and bulk agree" property
  structural rather than remembered.
- **Reusing `createAssignmentNotification` rather than a parallel emitter.**
  The shape is identical — "this entity is now your responsibility", deduped
  per (entity, user, day) — and only the recipient's role differs. A second
  module would have duplicated the dedupe key, the SSE fan-out and the
  skipDuplicates handling.
- **A compound filter key, not a bare `reviewerUserId` facet.** "Reviewer is
  X" also returns tasks X will review eventually and tasks X already signed
  off. Neither is the queue anyone means by "awaiting my review".
- **No KPI card.** The item mentioned one; the card would need
  `getTaskMetrics` to become user-scoped, which puts a per-user number
  through a tenant-scoped metrics cache. The filter is the useful half and
  is self-contained; the KPI is a separate change with its own cache
  question to answer.
- **The rendered test asserts rows only after an interaction.** Under
  React 19 act semantics the initial SWR read settles outside the act
  queue, and an assertion placed before any `fireEvent` raced it — the
  first cut failed roughly one run in two on a loaded machine, at four
  minutes a run. The test now waits on chrome (the toggle's
  `aria-pressed`) for its baseline and asserts rows either side of a
  click, which is stable; the deep-link case asserts the pressed toggle
  and the outgoing request rather than the rendered rows.

- **Email is not wired.** `EmailNotificationType` is a distinct enum with a
  distinct outbox; the bell is the in-app surface. Adding a review-request
  email is a follow-up, not an oversight of this one.
