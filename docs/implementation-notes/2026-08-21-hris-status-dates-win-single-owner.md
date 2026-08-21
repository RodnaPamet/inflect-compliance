# 2026-08-21 — one owner for "dates beat the status string"

**Commit:** `(this PR)` fix(hris): give BambooHR the ordering Workday was fixed for, once

## The defect

`mapBambooStatus` in `providers/hris/index.ts` read the vendor's status string
before it read the dates:

```ts
const s = (row.status || row.employmentStatus || '').toLowerCase();
if (s.includes('terminat')) return 'TERMINATED';   // ← returns immediately
if (s.includes('leave'))    return 'LEAVE';
if (row.terminationDate && new Date(row.terminationDate) > now) return 'OFFBOARDING';
```

That is the same inversion `mapWorkdayStatus` was fixed for in #2012, in the same
two tokens, written independently a couple of months earlier. Nothing connected
the two mappers, so fixing one did not surface the other — the Workday fix landed
with a note explaining the rule and BambooHR kept doing the opposite.

## Why it matters now

The leaver pass reads `Employee.status === 'TERMINATED'`
(`usecases/identity-leaver-pass.ts:383`) and hands those employees' links to
`findLeaverCandidates` for a directory disable. Both directions of the
misordering now have a consequence, and they are different consequences:

| feed says | old BambooHR answer | correct answer | what the old answer costs |
| --- | --- | --- | --- |
| status "Terminated — Notice", last day next month | TERMINATED | OFFBOARDING | the leaver pass disables somebody who is still employed and still working |
| status "Active" (or "Separated"), last day last month | ACTIVE | TERMINATED | the departed worker's directory account stays enabled indefinitely |

The second row is the one that is easy to miss. `includes('terminat')` matches
no tenant that names its leaver status "Separated", "Departed" or "Alumni", so
with the string leading, such a tenant would never retire anyone through this
path at all — a total failure that reports nothing.

Behaviour-neutral in the field today: the leaver pass is clamped at `DRY_RUN` and
no tenant has a directory connection, which is exactly why this was worth doing
now rather than after.

## Design

The rule moves out of both mappers into
`providers/hris/employment-status.ts::deriveEmploymentStatus(signals, now)`.
Each provider extracts its own row shape into a common `EmploymentSignals`
(`statusText` / `hireDate` / `terminationDate`) and the shared function decides.

```
BambooHR row ─┐                                   ┌─ OFFBOARDING / TERMINATED  (termination date)
              ├─► EmploymentSignals ─► derive… ──►├─ ONBOARDING                (future hire date)
Workday row ──┘                                   ├─ TERMINATED / LEAVE / ONBOARDING (status tokens)
                                                  └─ null → provider's own last resort
```

`null` rather than a defaulted `ACTIVE` is what makes one function serve both
providers. Workday has a third signal the shared rule cannot know about
(`activeStatus: false` with no dates reads TERMINATED); BambooHR has nothing, so
`null` there means `ACTIVE`. Collapsing "no signal" into "positively active"
inside the shared function would have deleted Workday's branch.

## Files

| file | role |
| --- | --- |
| `src/app-layer/integrations/providers/hris/employment-status.ts` | new — the rule, and the only place the status tokens are matched |
| `src/app-layer/integrations/providers/hris/index.ts` | `mapBambooStatus` delegates; picks which of two status fields speaks |
| `src/app-layer/integrations/providers/workday/roster.ts` | `mapWorkdayStatus` delegates; keeps its `activeStatus` last resort |
| `tests/unit/integrations/hris-employment-status.test.ts` | new — both directions of the rule, date parsing, the null contract |
| `tests/unit/integrations/hris-provider.test.ts` | BambooHR now asserts the ordering through the real roster fetch |
| `tests/guards/hris-status-rule-single-owner.test.ts` | new — no second copy of the token matching under `providers/` |

## Decisions

- **Fixed at the mapper, not at the leaver pass's query.** A `terminationDate`
  predicate on the terminated-worker selection was considered and declined
  (#143): it is a second copy of a rule the mapper already holds, it only helps
  the one consumer while every other reader of `Employee.status` keeps the wrong
  answer, and in its natural `lte` form it silently excludes the legitimately
  terminated workers whose `endDate` is structurally null — including anyone the
  HRIS departure reconcile retired by absence, who would become permanently
  un-offboardable while the pass reported `PASSED`.

- **Extracted rather than copied the fix across.** Two mappers that must agree
  and have already disagreed once are the argument. The extraction is also what
  proves the Workday behaviour survived: `tests/unit/workday-roster.test.ts` is
  untouched and still green, including the three assertions #2012 added.

- **One existing BambooHR expectation changed, and it is the mirror direction.**
  `does not treat a past termination date as OFFBOARDING` asserted `ACTIVE`; it
  now asserts `TERMINATED`. The test's own name is satisfied either way — the
  `ACTIVE` was incidental — but the value was the string beating the date, which
  is the second row of the table above.

- **The guard is named for the invariant, not the diff.** It scans every file
  under `providers/` for the status-token matching and allows exactly one, and
  its first assertion checks that the detector still matches the owner — a
  detector bound to nothing would let every "no other file matches" assertion
  pass while checking nothing. It fires on a real future event: somebody adding
  a Gusto or Rippling mapper and hand-rolling the tokens.

## Unproven, and recorded as such

A rehire — a past `terminationDate` alongside a newer `hireDate` — resolves to
`TERMINATED`, because the termination date is read first and returns
unconditionally. That is unchanged from the Workday mapper as #2012 left it, and
it is now shared by both providers rather than being one provider's quirk.

It is left alone deliberately. Whether either vendor actually emits both dates on
a rehired worker (rather than clearing the termination date) is an empirical
question about live data that no sandbox is available to answer, and inventing a
`hireDate > terminationDate` tie-break would change Workday behaviour that #2012
pinned on purpose, on a guess. The rails downstream — the `DRY_RUN` clamp, the
link-freshness requirement, the batch breaker and the journal — are the things
standing between this edge and a wrong disable.
