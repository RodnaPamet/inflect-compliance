# 2026-08-12 — Calendar: the badge says what it counts, and isolation is tested

**Commit:** `<pending>` test(calendar): name the badge honestly, prove tenant isolation

Box 3 items #20 and #23. The badge question was a product call, answered by the
repo owner: **the divergence is intended — the badge is "my tasks", just badly
named.** Everything below follows from that.

## The badge counted one thing and promised another

`getUpcomingDeadlineCount` counted `db.task`, filtered to
`assigneeUserId === ctx.userId`. The page beside it aggregates **nineteen
sources tenant-wide**. Two different questions, and nothing asserted the
difference — so every time someone compared the two numbers it read as a bug.

The query's own comment already said *"Personal badge: only the caller's own
tasks."* The **name** was the only thing lying, so this is a rename plus three
tests that pin the divergence deliberately:

- the `where` carries `assigneeUserId === ctx.userId` (the scope that makes it
  personal);
- **only** `task.count` is called — the other eighteen sources are not touched;
- a case where the page has events and the badge is `0`, because the one risk in
  range belongs to someone else.

That third one is the point. A future reader who notices the numbers disagree
now finds an assertion saying so, not a discrepancy to "fix". If the badge
should ever mirror the page, that is a behaviour change to the most-glanced-at
number in the app — not a rename.

## The isolation test proves less than it looks, and says so

`tests/integration/calendar-tenant-isolation.test.ts` runs the real usecase
against a real database with two tenants holding deliberately similar data.

Then I mutation-tested it by deleting `tenantId: ctx.tenantId` from the policy
loader — and **it stayed green.** `runInTenantReadContext` binds the `app_user`
role, so RLS filtered the rows the application layer stopped filtering.

That is good news about the system and bad news about the claim I had written in
the docblock ("both controls are exercised"). What the test actually proves is
that the two layers *together* isolate — the user-facing guarantee — and it
cannot attribute isolation to either one. The docblock now says exactly that,
and points at the unit suite's `where`-shape sweep as the thing that asserts
every loader still carries its predicate.

Worth recording because the failure mode is subtle: a green integration test
would have let someone delete an application-layer tenant filter and believe the
suite had cleared it.

## Two hand-enumerated test lists had quietly stopped meaning what they said

Both in the same file, both the same shape:

- **the tenant sweep** listed twelve mocks inline, so the seven sources added
  since simply left the assertion. "Every Prisma query is tenant-filtered" was
  checking twelve of nineteen.
- **the all-sources-fail case** (fixed in the previous PR) listed seventeen, so
  adding two turned it into "seventeen of nineteen fail" — still green, no
  longer the assertion.

Both now derive from `ALL_SOURCE_MOCKS`, with a floor assertion so a filter that
empties the loop fails rather than passing vacuously.

## The do-not-touch record (#23)

`docs/calendar-surface-do-not-touch.md`, mirroring the audits one. Six things
that look like defects and are not: per-source authorization (stricter than the
repo norm), the double tenant scoping, per-source truncation with
nearest-survives ordering, three renderers that share no extractable core, the
benign Zod split, and `SOURCES_WITHOUT_OWNER`.

Entry 5 says "fix the doc, not the code" about CLAUDE.md describing
`src/lib/schemas/` as "shared" when it has **zero client importers** — so this
PR fixes it, rather than filing a note about a note.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/compliance-calendar.ts` | `getUpcomingDeadlineCount` → `getMyUpcomingTaskCount`, with the divergence documented |
| `src/app/api/t/…/calendar/route.ts` | stale "17 domains" → 19 |
| `tests/integration/calendar-tenant-isolation.test.ts` | new — two tenants, real DB |
| `tests/unit/compliance-calendar.test.ts` | badge divergence pinned; tenant sweep made total |
| `docs/calendar-surface-do-not-touch.md` | new — authoritative |
| `CLAUDE.md` | `src/lib/schemas/` is backend, not shared |

## Decisions

- **The badge was renamed, not changed.** Making it mirror the page would alter
  a number users read constantly, on the strength of an inference about intent.
  The owner confirmed the scope is deliberate, so the fix is the name and a test
  that records the decision.

- **Route tests and the `resetModules` churn are NOT in this PR.** Both API
  routes still have no executing tests, and
  `tests/unit/compliance-calendar.test.ts` still calls `jest.resetModules()` in a
  top-level `beforeEach` with ~22 dynamic imports of a 1,800-line import graph.
  Named here rather than half-done — and the resetModules work is much cheaper
  after the usecase split, which is the next PR.

- **Seven of nine `data-testid`s remain unreferenced.** Two are now used by the
  filter-panel tests. The rest are still the open half of the previous PR's
  deferral; converting them to `id` touches a guard's greps and belongs with the
  route/E2E work that would give them a purpose.
