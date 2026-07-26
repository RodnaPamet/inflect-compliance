# 2026-07-27 — Calendar deep-link correctness + scheduler tz/dedupe

**Commit:** `<sha>` fix(calendar): distinct event deep-links + node-cron tz + jobId-dedupe honesty

## Design

Residue from the compliance-calendar audit — hrefs that RESOLVE (not the 404s
fixed earlier) but land somewhere that doesn't show the thing the user clicked,
plus two scheduler-correctness/honesty fixes.

### Deep-link destinations
Six event types landed on an entity ROOT that showed no sign of the specific
deadline:
- Four `risk`-category types collapsed to `/risks/{id}`. `risk-target`,
  `treatment-plan-target`, and `treatment-milestone-due` now deep-link to
  `?tab=assessment` (where the treatment plan / target lives); `risk-review`
  keeps the overview root — four distinct destinations.
- `vendor-review` and `vendor-renewal` were identical → renewal now targets the
  contract-renewal field anchor (`?tab=overview#vendor-contract-renewal`).
- `control-exception-expiry` → `#control-exceptions` (the exceptions panel on
  the control overview).
- `incident-notification-due` → `#incident-notification-{id}` (the specific
  NIS2 Art.23 notification obligation, not the incident root).

The three anchor targets (`id="vendor-contract-renewal"`,
`id="control-exceptions"`, `id="incident-notification-{n.id}"`) were added to
the respective detail pages, each with `scroll-mt-24` so the sticky header
doesn't cover the scrolled-to element. The risk and vendor pages already honour
`?tab=`; the control/incident anchors land on the DEFAULT (overview) tab, so a
native hash scroll works without adding `?tab=` URL handling.

The `calendar-ux-completeness` ratchet gained a "distinct types → distinct
destinations" assertion and an "anchor targets exist on their pages" assertion,
and its href-resolver now strips the `#anchor` too.

### node-cron tz + step math
`cronMatchesNow` (the `scheduler.tick()` path) evaluated crons in UTC only,
ignoring each schedule's `tz` — so the tick path fired a schedule at a
different wall-clock time than the BullMQ path (which honours `tz`). It now
derives the cron fields in the schedule's timezone via `Intl.DateTimeFormat`
(UTC fast-path preserved), and `tick()` passes `schedule.tz`. Separately, the
`*/N` step used `value % step`, which is wrong for 1-based fields
(day-of-month, month) — `*/2` on day-of-month matched 2,4,6 instead of 1,3,5.
It now anchors at the field minimum: `(value - min) % step === 0`.

### jobId-dedupe honesty
`schedules.ts` header now states the real guarantee: BullMQ's deterministic
jobId dedupe holds only WITHIN the `removeOnComplete: 500` retention window;
the durable exactly-once guarantee is per-job (`dedupeKey` unique indexes,
conditional `updateMany` claims). New scheduled jobs that must never double-fire
must carry their own durable key. Also corrected the stale
`control-test-scheduler` description (it no longer filters `automationType IN
(SCRIPT, INTEGRATION)` — it scans ACTIVE plans whose `nextRunAt` is due/NULL).

## Files
| File | Role |
|---|---|
| `compliance-calendar.ts` | 6 event hrefs → tab/anchor deep-links |
| `vendors/[vendorId]/page.tsx` | `id="vendor-contract-renewal"` anchor |
| `controls/[controlId]/page.tsx` | `id="control-exceptions"` anchor |
| `incidents/[incidentId]/page.tsx` | per-notification anchor id |
| `jobs/scheduler.ts` | tz-aware `cronMatchesNow` + field-min-anchored `*/N` |
| `jobs/schedules.ts` | dedupe-honesty header + accurate scheduler desc |
| `tests/guards/calendar-ux-completeness.test.ts` | distinct-destination + anchor-exists assertions; `#`-aware resolver |
| `tests/unit/scheduler-foundation.test.ts` | tz + step-math cron cases |

## Decisions
- **Anchors over new tabs/URL-tab handling.** The control/incident notification
  panels already render on the default overview tab, so a hash anchor
  scroll-targets them with zero new routing — cheaper and less risky than adding
  `?tab=` URL handling to those pages.
- **Kept `computeNextRunFromCron`'s UTC fast-path.** Only schedules that set
  `tz` pay the `Intl` cost; the common UTC schedules stay on the integer path.
- **Documented the dedupe bound rather than adding a global idempotency store.**
  The jobs that matter are already durably idempotent at the work layer; a new
  store would duplicate that guarantee.
