# 2026-08-12 — Calendar: three "shared" primitives go home, and the week starts once

**Commit:** `<pending>` refactor(calendar): move the calendar-only primitives into the route

Box 3 items #18 and #22. The interesting part is what moving files revealed.

## Design

### The primitives were never shared

`CalendarMonth` (523), `CalendarHeatmap` (373) and `GanttTimeline` (286) lived in
`src/components/ui/`. Verified on the current tree:

- each has **exactly one** importer — `CalendarClient.tsx`;
- each imports `@/app-layer/schemas/calendar.schemas`;
- each calls `useTranslations('calendar')` — the route's namespace.

That is one page's requirements parked in the shared tree where every
contributor pays to maintain them, and where the next person to open
`components/ui/` reasonably assumes they are general-purpose. They now live in
`calendar/_components/`, matching the `_form/` + `_lib/` convention the audits
route already uses. Every import in them is `@/`-aliased, so the move needed no
path rewriting inside the files themselves.

### The week started on two different days, on one page

`date-picker/calendar.tsx` defaults `weekStartsOn = 1` (Monday). `CalendarMonth`
padded its grid with a bare `monthStart.getUTCDay()` — Sunday-first, and no way
to say otherwise. Both render on the calendar page. Pick a date in the picker,
look for it in the month grid, and it is under a different column.

`WEEK_STARTS_ON` is now one constant both read, and the grid's padding is
`(getUTCDay() - WEEK_STARTS_ON + 7) % 7` rather than an assumption. The weekday
header labels walk from the same offset.

It is a module constant rather than a locale lookup, deliberately: making it
locale-driven means the server-rendered grid and the client hydration must agree
on locale *before first paint*, and a mismatch there is a hydration error rather
than a cosmetic one. When the calendar becomes locale-aware, this is the single
place that changes — which is the actual win over two hardcoded answers.

`CalendarMonth`'s private `toYMD` also went; `date-utils` already exported one.
Its signature is `string | null` (it validates), so the call site handles the
null rather than asserting — the fallback is unreachable given the input is
arithmetic on a known-good month start, and writing it that way keeps the
function total.

### The move tripped a ratchet, and the ratchet's advice was wrong

`epic60-ratchet` caps inline `e.key === 'Enter'` handlers **in `src/app/**`**.
Moving `CalendarMonth` across that boundary raised the count from 1 to 2 without
anyone writing a handler.

Its error message says to use `useEnterSubmit`. That would have been wrong. The
handler is an ARIA grid's roving-tabindex navigation: Enter and Space select the
focused cell, the arrow keys move focus, and it is one `switch` that must own
the whole key set. Routing the Enter half through a submit hook would split one
keyboard contract across two mechanisms to satisfy a counter.

Cap raised to 2 with that reasoning recorded in place. A ratchet that is right
about the count and wrong about the remedy is still doing its job — it forced
the question.

## The two small ones (#22)

**`TERMINAL_WORK_ITEM_STATUSES`.** `loadTaskEvents` hand-wrote
`RESOLVED || CLOSED || CANCELED` — the same three strings the file already
imports and uses correctly 240 lines below. Add a terminal status to the enum
and the hand-written twin keeps calling those tasks open, on the surface whose
job is reporting what is due.

**Read-after-write against a replica — documented, not fixed.** The client
PATCHes a task and then `calQuery.mutate()`, and that read goes through
`prismaRead`, which IS the replica when `DATABASE_READ_URL` is set;
`src/lib/prisma.ts` explicitly forbids reading your own write from it.

What keeps it survivable: `optimisticPatch` has already applied the change
locally, so replica lag surfaces as a brief **revert** — the reconciliation
paints the old value until the next revalidation — not a lost write. The write
landed on the primary.

Not fixed here because the fix is an API-shape change (the route must be told to
read the primary for one request), and doing it as a one-off flag on one route
would be the wrong seam — other surfaces have the same optimistic-write-then-
refetch shape and should share whatever affordance gets built.

## Files

| File | Role |
| --- | --- |
| `calendar/_components/{CalendarMonth,CalendarHeatmap,GanttTimeline}.tsx` | moved from `components/ui/` |
| `src/components/ui/date-picker/week-start.ts` | new — the one week-start constant |
| `src/components/ui/date-picker/calendar.tsx` | reads it instead of defaulting to 1 |
| `src/app-layer/usecases/compliance-calendar.ts` | task loader uses the imported terminal statuses |
| `src/app/t/…/calendar/CalendarClient.tsx` | the replica window documented at the call site |
| `tests/guards/epic60-ratchet.test.ts` | Enter cap 1 → 2, with the relocation + grid-nav reasoning |
| `tests/guardrails/design-system-drift.test.ts` | stale budget reason corrected |

## Decisions

- **The `+2` design-drift budget was NOT reclaimed, and the comment now says
  why.** Its recorded reason — "both leaning on legacy `btn btn-*` +
  `glass-card`" — is false today: zero occurrences in either file. But the check
  is an ALLOWLIST (`allPages` minus `MIGRATED_PAGES`), not a class scan, so the
  count stands until someone asserts the page meets the whole migration bar.
  Correcting a stale reason is in scope; making that assertion is not.

- **A rendered suite produced NO OUTPUT until the heap was raised.** Worth
  recording because it is indistinguishable from a hang or a kill:
  `--max-old-space-size=2048` was too small for a jsdom rendered test, and the
  process died silently. At 6144 it passed in seconds.
