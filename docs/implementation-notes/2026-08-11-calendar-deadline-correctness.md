# 2026-08-11 — Calendar: four things the product stated falsely about deadlines

**Commit:** `<pending>` fix(calendar): deadlines reach the right person and report the right state

Four verified defects on the Calendar surface. Each made the product either tell
the wrong person about a deadline, or state something false about one. All four
reproduce on `main`; none had a test.

## Design

### 1. The digest had no idea who still worked there

`resolveRecipients` was a bare
`prisma.user.findMany({ where: { id: { in: userIds } } })` — no tenant, no
membership, no status — on the unscoped client. Owner ids arrive from entity
columns (`Control.ownerUserId`, `Policy.ownerUserId`, `Task.assigneeUserId`, …)
and **none of them are cleared when a membership is deactivated**:
`deactivateTenantMember` writes only `status` + `deactivatedAt`. So a departed
employee kept receiving that tenant's compliance deadlines — entity names, due
dates and links — nightly, indefinitely.

RLS is not a backstop and could not become one. `User` is a global model with no
tenant column and no row-level policies, and this path runs outside
`runInTenantContext`, where the `superuser_bypass` policy admits the raw client
by design. The membership predicate **is** the control. `resolveTenantAdmins`,
five lines below, had always had it.

Two things beyond swapping the query:

- **The map key had to become composite.** It was keyed on `userId` alone, so a
  person ACTIVE in tenant A and DEACTIVATED in tenant B collapsed into one entry
  — a per-tenant filter is not expressible against that key. It is now
  `${tenantId}:${userId}`.
- **The drop count is logged.** A dropped owner is counted `unroutable`, which is
  indistinguishable from "this user was deleted". Without the log, recipient
  shrinkage after an offboarding looks identical to a broken lookup.

### 2. `resolveTenantAdmins` excluded OWNER — found while fixing the above

Not in the brief, but in the same function pair and the same class of bug. The
fallback filtered `role: 'ADMIN'`, and Epic 1 made OWNER *strictly superior* to
ADMIN. A tenant whose only privileged member is an OWNER — the shape every
tenant starts in, since `createTenantWithOwner` mints an OWNER and nothing else —
resolved zero fallback recipients, so every unowned item was counted
`unroutable` and dropped. **No digest at all.** Shipping a corrected
`resolveRecipients` next to this would have been half a fix.

### 3. "My deadlines" hid eleven of seventeen sources

The filter is `e.ownerUserId === currentUserId`, and `ownerUserId` is optional —
so a source that never sets it is not shown as unowned, it *vanishes*. Eleven
did. The repairs split three ways:

| Kind | Sources | Fix |
| --- | --- | --- |
| Column existed, loader never selected it | policy, risk, control-test-plan, treatment-plan | select + emit |
| No own owner column | treatment-milestone, incident-notification, control-exception, vendor-document, vendor-assessment, audit-cycle | inherit from the parent, or the row's accountable actor |
| Wrong column entirely | finding | see §4 |

The brief named the first four and three of the derived ones. I did the other
three as well — `vendor-document` and `vendor-assessment` inherit the vendor's
owner, `audit-cycle` uses `createdByUserId` — because the alternative was to
report them to the user as "cannot be filtered by owner", which would have been
false. Sixteen of seventeen now participate.

`control-exception` uses `riskAcceptedByUserId` rather than `createdByUserId` or
the parent control's owner, because that is the **primary recipient
`exception-expiry-monitor` already emails about this same date**. The calendar
and the reminder now name the same person.

`training` genuinely cannot participate: a `TrainingAssignment` belongs to an
`Employee`, and `Employee` has no link to a platform `User` — only `workEmail`.
Matching on email would be a guess presented as an assignment. It is listed in
`SOURCES_WITHOUT_OWNER` and the UI now says so when the toggle is on, mirroring
how the permission path already reports `omittedSources` instead of
under-reporting silently.

### 4. The finding loader published a person's NAME as a user id

`Finding.owner` is legacy free text. The schema says so, in a comment sitting
directly above the `assigneeUserId` that supersedes it. Both the calendar loader
and `calendar-deadlines.ts` selected `owner` and emitted it as `ownerUserId`.

A name can never equal a cuid, so "My deadlines" matched no finding for anyone —
including its actual assignee — and finding deadline notifications were 100%
unroutable.

**No `?? r.owner` fallback**, deliberately. A name in that field is strictly
worse than absence: absent, the digest routes the item to tenant admins; a name
resolves to no user and the item is *dropped*. There is a real, visible
consequence at deploy — legacy findings with a name and no assignee become
unowned and reach the admin fallback, so admins will see finding deadlines they
were never emailed before. That is the intended routing; it was simply
unreachable while the name occupied the field.

### 5. An IMPLEMENTED control's lapsed test rendered as "done"

`classifyStatus` short-circuits `if (isDone) return 'done'` *before* any date
comparison, and the control loader passed `isDone = status === 'IMPLEMENTED'`.
But `nextDueAt` is the next **test** due date — it is written in exactly one
shape, "a test just ran, roll the clock" (`attestControlTested`). An IMPLEMENTED
control is precisely the one that must be tested on cadence.

Every other status-derived `isDone` in the file names a state that
*extinguishes the obligation the date encodes* — an ARCHIVED policy has no
review left, a CLOSED finding has no remediation left. Control is the one case
where the status and the date describe two different obligations.

Meanwhile `deadline-monitor` emailed the same row as overdue. Two systems, one
row, opposite answers — and the user looks at the calendar.

The fix is a shared module, `domain/control-test-due.ts`, so the two agree by
construction rather than by two literals that happen to match:
`CONTROL_TEST_ELIGIBILITY` (spread into both where-clauses) and
`isControlTestSatisfied()`. The latter always returns `false` and is
deliberately a named function rather than a literal at the call site — it is the
assertion "no control state satisfies the test clock", and it belongs next to the
reasoning. A bare `false` in the loader invites exactly the
`status === 'IMPLEMENTED'` guess that was there before.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/notifications/digest-dispatcher.ts` | membership-scoped recipients, composite key, drop log, OWNER in the fallback |
| `src/app-layer/domain/control-test-due.ts` | new — the one definition of "is this control's test due" |
| `src/app-layer/usecases/compliance-calendar.ts` | 10 loaders emit an owner; finding reads the FK; control drops the status short-circuit |
| `src/app-layer/jobs/calendar-deadlines.ts` | finding reads `assigneeUserId` |
| `src/app-layer/jobs/deadline-monitor.ts` | shares the control eligibility fragment |
| `src/app-layer/schemas/calendar.schemas.ts` | `SOURCES_WITHOUT_OWNER`; corrected stale prose about notification routing |
| `src/app/t/…/calendar/CalendarClient.tsx` | notice naming sources the owner filter cannot include |

## Decisions

- **Every test asserts the emitted event or the outbox, never the select
  shape.** A select assertion passes while the value never reaches the DTO —
  this repo's worked example is the Assets status control, where a guard
  asserted the schema *mentioned* `status` while the control persisted nothing
  for months. The digest tests assert what was queued for delivery, not the
  returned counters: an item counted `unroutable` but still written is a mail
  that goes out.

- **The stale comment on `CalendarEvent.ownerUserId` was corrected, not
  extended.** It claimed the field feeds "the deadline monitor's notification
  routing". It does not — both jobs build their own `DueItem.ownerUserId` from
  independent queries and never import the usecase. Widening a loader here
  cannot change who gets emailed, and a future contributor reasoning from that
  sentence would have concluded the opposite.

- **The digest's `unroutable` bucket is not re-routed to admins.** A dropped
  owner's items stay unroutable rather than falling back, because `groupItems`
  already classified them as owned — an offboarded owner's deadlines becoming
  admin mail on the night of deactivation would be its own surprise.
