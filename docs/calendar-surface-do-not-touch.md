# The Calendar surface: what is already right

This file exists to stop work, not to start it.

Six parts of the Calendar surface were examined during the 2026-08 review and
found **correct**. Each one looks, at a glance, like the kind of thing a sweep
would "fix" — an authorization gate, a set of tenant filters, a truncation
policy, three renderers that look duplicated, a schema split, a permission
comment. Reviewing them again costs an afternoon; changing them costs a
regression in code that is currently load-bearing and correct.

If you are here because a linter, an audit, or an LLM suggested a change to one
of these, read the entry first. The reasoning that made each one correct is not
visible from the code alone.

Companion to [`audits-surface-do-not-touch.md`](audits-surface-do-not-touch.md).

---

## 1 · Per-source authorization — `compliance-calendar.ts`

**Stricter than the repo norm, deliberately.** The aggregation does not gate on
a single `assertCanRead(ctx)` and then read nineteen domains. Each source
carries its own `PermissionKey`, is filtered out when the caller lacks it, and
the denied domains are reported to the client as `omittedSources` so the UI can
say "some sources are hidden by your permissions" rather than silently
under-reporting.

The code names the weaker pattern it rejects. A sweep that "simplifies" this to
one gate at the top would turn a permission-aware surface into one that shows a
READER the incident and personnel domains.

`CALENDAR_BASELINE_PERMISSIONS` exists for the route gate and is the *distinct
set* of those per-source keys — not a hand-maintained second list.

## 2 · Every fan-out read is tenant-scoped, twice

All reads carry an explicit `tenantId: ctx.tenantId` **and** run inside
`runInTenantReadContext`, which binds the RLS `app_user` role. Both layers are
live.

This was verified by experiment, not by reading: deleting `tenantId` from the
policy loader and running `tests/integration/calendar-tenant-isolation.test.ts`
leaves it **green**, because RLS catches what the application layer stopped
catching. Do not read that as licence to drop the application filter — it is
the layer that makes a mistake *visible* in a query you can read, and the unit
suite's `where`-shape sweep asserts it across every source.

## 3 · Per-source truncation, with the nearest deadlines surviving

Each loader caps at `perSourceLimit` ordered by its date column ascending, so a
cap drops the *furthest-out* deadlines rather than an arbitrary slice. The
truncation is reported (`truncation.capped`, the limit, and which sources hit
it), the UI renders it, and `counts.partial` propagates so a post-truncation
count is never presented as authoritative.

This is the pattern the Audits SharePoint export lacked, and the reason a
capped calendar is honest rather than quietly wrong. Removing the reporting to
"clean up the DTO" would restore exactly the failure the audits review found.

## 4 · The three renderers are not near-copies

`CalendarMonth`, `CalendarHeatmap` and `GanttTimeline` look like three
implementations of one idea. They are not: a 42-cell padded month grid, a
365-day density strip with a roving tabindex over ~546 cells, and a
proportional-position timeline share no month-grid maths and no DST logic worth
extracting. An "extract the common calendar core" refactor would invent a shared
abstraction over three genuinely different layouts.

(The duplication that *was* real — the week-start disagreement and a private
`toYMD` — is fixed; see
[`2026-08-12-calendar-primitive-ownership.md`](implementation-notes/2026-08-12-calendar-primitive-ownership.md).)

## 5 · The two Zod schema locations hold no duplicated entity

`src/app-layer/schemas/` and `src/lib/schemas/` look like a split that wants
merging. Nothing is duplicated between them; the split is benign.

What *is* wrong is CLAUDE.md's rationale for it: `src/lib/schemas/index.ts` is
1,135 lines of pure API request bodies with **zero client importers**, so it is
backend-only despite being documented as "shared". **Fix the doc, not the code.**

## 6 · `SOURCES_WITHOUT_OWNER` is a list of one, and should stay that way

`training` cannot participate in the "My deadlines" filter because a
`TrainingAssignment` belongs to an `Employee`, and `Employee` has no link to a
platform `User` — only `workEmail`. Matching on email would be a guess presented
to the user as an assignment.

Do not extend this list to paper over a loader that simply forgot to select its
owner column. That is the bug the list was born from: eleven of nineteen sources
silently vanished from the filter because their loaders never selected an owner,
and adding them to an exclusion list would have made the omission look
considered. If an Employee↔User link is ever added, delete the entry and the
notice it drives.

---

## What this file is not

It is not a claim that the Calendar surface is finished. Open items are tracked
outside this file and recorded in
`docs/implementation-notes/2026-08-1*-calendar-*.md` — among them the per-tenant
timezone, the post-write replica read, and the usecase split. This file covers
only the parts that were examined and found **already right**.
