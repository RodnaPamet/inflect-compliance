# 2026-08-12 — Calendar: five places it reported confidently and was wrong

**Commit:** `<pending>` fix(calendar): report failures, filter deleted parents, agree on what a day is

Box 2 of the calendar roadmap. Where box 1 fixed *who* deadlines reached, this
fixes *what the surface claims*. Three of the five turned out larger than
briefed.

## Design

### 1. Soft-deleted parents leaked through child loaders — six pairs, not one

`src/lib/soft-delete.ts` injects `deletedAt: null` into the TOP-LEVEL
`args.where` only. It never descends into `select`/`include`, and Prisma has no
global relation filters, so a nested join on a required to-one relation is
unconditional. Two independent facts made that reachable:

- a child model may have no `deletedAt` column at all (`VendorDocument`,
  `VendorAssessment`, `TreatmentMilestone`), so it is correctly absent from
  `SOFT_DELETE_MODELS` and correctly never filtered; and
- a soft delete is an UPDATE, so the schema's `onDelete: Cascade` never fires
  and children are never deleted in sympathy.

The brief named one leak and estimated five. There are six:

| Loader | Relation | Why it hid |
| --- | --- | --- |
| `loadVendorDocumentEvents` | `vendor` | the briefed one |
| `loadVendorAssessmentEvents` | `vendor` | same shape |
| `loadTestPlanEvents` | `control` | plan's OWN `deletedAt` is auto-injected, so it read as handled |
| `loadControlExceptionEvents` | `control` | has a hand-written own-`deletedAt`, same illusion |
| `loadTreatmentPlanEvents` | `risk` | ditto |
| `loadTreatmentMilestoneEvents` | `treatmentPlan.risk` | **second-order** |

The last is the interesting one. It already filtered
`treatmentPlan: { deletedAt: null }`, which reads as done — but a milestone's
click-through lands on `/risks/{riskId}`, so a live plan under a deleted risk
produced a calendar entry pointing at a page the user cannot open.

The pattern that hid four of these is worth naming: **a model having its own
`deletedAt` predicate says nothing about its relations.** Reviewing for "does
this loader filter deleted rows?" answers the wrong question.

The guard resolves each loader's joins through the **Prisma DMMF** rather than a
curated list, so a new loader or a new join is covered the day it lands.

### 2. The fan-out had no error isolation, and three comments claimed it did

`mapWithConcurrency` awaits inside each worker and joins with `Promise.all`.
Each loader ran inside `runInTenantReadContext(..., { timeout: 8_000 })` — a
Prisma interactive-transaction budget, which **rejects** on breach. There was no
`catch` anywhere in the 1,586-line file. So one slow or broken loader 500'd the
entire calendar: seventeen domains, all three views.

The comment read *"One slow source fails alone, not the whole calendar."* A
timeout bounds one source's work; it does not make the failure survivable. That
sentence is exactly what a future "simplify" PR would trust.

Two decisions:

- **The sentinel is index-aligned.** `cappedSources` reads `results[i]`
  positionally against `eligible`, so returning a filtered (shorter) array would
  leave `results[i]` undefined for the tail — converting a partial-data bug into
  a `TypeError`, a worse outage than the one being fixed.
- **`failedSources` is a separate DTO field from `omittedSources`.** "You cannot
  see this" and "this failed to load" are different facts and only one is worth
  retrying. It also sets `counts.partial`, because a missing source makes the
  summary an undercount.

**All sources failing throws.** An empty grid plus a notice reads as "nothing is
due"; on a deadline product that is the most dangerous thing this surface can
say. A total outage should look like one.

### 3. Five definitions of "day" on one screen, not three

The brief found three. There were five: UTC grid cells, a browser-local month
ring, a server-zone status, **the heatmap's own UTC today**, and **a raw-instant
Gantt marker**. Switching the view toggle could move which cell counted as today.

The fix is not the obvious one. Converting the client to the server zone was
rejected: the client cannot read a server-only env var, and re-dating events
would break the write path — the reschedule flow sends a bare `dueAt: ymd`, and
`date-utils` and every display formatter are UTC-pinned. The client's day
identity is already consistently UTC; only the ring and the status were outliers.

So: **the deadline's day stays UTC — the zone applies to the observer, not the
deadline.** `daysUntilInTz` now compares `utcDayOf(target)` (exactly what
`event.date.slice(0, 10)` names, so status and cell agree by construction)
against `civilDayForNow(now, tz)`. The server publishes `todayYmd`, and all
three views ring that day instead of deriving their own.

Output is bit-identical for any zone at offset ≥ 0, including the shipped
default. A deployment on a negative-offset zone will see day-resolution
deadlines stop reading `overdue` about a day early — a fix, but a visible one.

`NOTIFICATIONS_TZ` is the single authority because **no timezone column exists
anywhere in the schema**. Per-tenant timezone is a new column, a migration, a
default for every existing tenant, and an admin UI — tracked separately. The
point of collapsing to one function first is that it becomes the *one* place
that would plug in, instead of five.

### 4. The digest mislabelled what it sent and misreported what it did

`entityType` was believed "informational only". It is not: the template drives
**both** the visible type label and the link href from it. Audit cycles arrived
labelled "Control" linking to `/controls`; findings arrived labelled "Task"
linking to `/tasks`.

Findings matter more than they look. Before box 1 they were 100% unroutable, so
the wrong label reached nobody. Box 1 fixed the routing — which made this
mislabel *live*. Both now have their own `MonitoredEntityType`; widening the
union turns `tsc` red until `ENTITY_LABEL`, `ENTITY_PATH` and `OWNERSHIP_RULES`
all follow, which is the safety net working.

The run record reported `itemsScanned` from `byEntity` — the number of items
*produced* — and hardcoded `itemsSkipped: 0`. Scanning 2 and emitting 1 was
indistinguishable from scanning 1 and emitting 1, and a scan that hit `SCAN_CAP`
looked identical to one with nothing to do. Scanners now return
`{ items, scanned, capped }`.

### 5. Per-event work

`civilDayInTz` constructed a fresh `Intl.DateTimeFormat` on **every call**, and
`daysUntilInTz` called it twice per event — once for the target and once to
recompute the zone's today, identically, for every event in the request. The cap
is applied *after* classification, so the cost is proportional to the pre-cap
count (~13,000 events worst case, not 5,000). Formatters are now cached per
timezone and `now`'s day memoised on `(ms, tz)`.

The empty-view probe fires a second full 17-source aggregation over a 730-day
window. It was gated on the **post-filter** `events`, so toggling "My deadlines"
into an empty result triggered the most expensive request the surface makes —
from a checkbox. It now gates on the server's result. A window with deadlines
that simply aren't yours is not an empty window.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/compliance-calendar.ts` | 6 nested predicates; per-source try/catch + `failedSources`; one day definition; formatter cache |
| `src/app-layer/schemas/calendar.schemas.ts` | `failedSources`, `todayYmd` |
| `src/app-layer/jobs/calendar-deadlines.ts` | own entity types; scanners report scanned/capped |
| `src/app-layer/jobs/types.ts` | `AUDIT_CYCLE` + `FINDING` on the union |
| `src/app-layer/notifications/digest-templates.ts` | labels + hrefs for both |
| `src/app-layer/domain/due-item-ownership.ts` | ownership rules for both |
| `src/components/ui/CalendarMonth.tsx`, `CalendarHeatmap.tsx` | ring from `todayYmd` |
| `src/app/t/…/calendar/CalendarClient.tsx` | failed-source notice; probe gated server-side |
| `tests/guardrails/calendar-nested-soft-delete.test.ts` | DMMF-driven relation guard |

## Decisions

- **The soft-delete guard reads the DMMF, not a list.** A curated list of
  loader/relation pairs would have to be maintained by the same people who
  forgot the predicate. Deriving "is this relation's target soft-deletable"
  from the datamodel means a new join is covered without anyone remembering.

- **Every mutation was verified.** Each of the four behaviours — isolation,
  `todayYmd`, the UTC-target comparison, honest run counts — was reverted and
  the corresponding test confirmed to fail. The soft-delete guard was verified
  by deleting two predicates, including the second-order one.

- **A raw `throw new Error` was caught by a ratchet and replaced with
  `internal()`.** Worth recording as a case where the guard suite did its job
  on this diff rather than a hypothetical future one.
