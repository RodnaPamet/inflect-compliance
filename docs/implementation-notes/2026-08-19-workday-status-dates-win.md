# 2026-08-19 — the Workday status mapping contradicted its own rule

**Commit:** `(this PR)` fix(workday): dates beat the status string, as documented

## The defect

`providers/workday/roster.ts` carries this in its docblock:

> Dates win over the status string, because the status string is the one an
> administrator can customise per tenant.

The code did the opposite, for the two tokens where it matters:

```ts
const raw = String(row.workerStatus ?? '').toLowerCase();
if (raw.includes('terminat')) return 'TERMINATED';   // ← returns immediately
if (raw.includes('leave'))    return 'LEAVE';
// Pending termination — still employed, last day in the future.
if (row.terminationDate) { … if (end > now) return 'OFFBOARDING'; }
```

A worker whose administrator-customised status read `"Terminated (Pending)"`
with a termination date a month out returned `TERMINATED` and never reached the
`OFFBOARDING` branch — the precise population the docblock three lines above says
the derivation exists to catch: *"the person who still has access during their
notice period."*

Dates *did* win everywhere below that point (over the pre-hire tokens, over
`activeStatus`), so the design was right and the first two lines were the
exception nobody noticed.

## Why no test caught it

Both relevant tests passed `workerStatus: 'Active'`:

```ts
{ workerStatus: 'Active', terminationDate: '2026-07-01' } // → OFFBOARDING
{ workerStatus: 'Active', terminationDate: '2026-01-01' } // → TERMINATED
```

`'Active'` never reaches the string branch, so both exercised only the path where
the defect is absent. **The suite validated the documented behaviour using inputs
that avoid the bug.** That is the shape worth remembering — the tests were not
weak, they were aimed one branch away from the fault.

## Severity is conditional, and that is the point

**Today it is latent.** The only consumer treats the two statuses identically —
`providers/personnel/checks.ts:67` filters
`status === 'TERMINATED' || status === 'OFFBOARDING'` for
`offboarded_access_removed`. Nothing visibly breaks.

**Under the JML leaver flow it is wrongful disablement.** That flow acts on
`TERMINATED`. A person serving notice would be classified `TERMINATED` the moment
HR enters the termination in Workday — not on their last day — and have their
account disabled while still employed and working.

So this is a latent bug that a *planned* feature would activate. It was found by
verifying the roadmap's own premises before building on them, which is the whole
argument for doing that.

## Decisions

- **Reorder, not rewrite.** Dates move above the string checks; the string
  remains the fallback it was always meant to be. The docblock did not change,
  because it was already correct.

- **One deliberate consequence, asserted rather than left implicit.** A worker on
  leave who *also* carries a termination date now resolves from the date
  (`OFFBOARDING`) rather than `LEAVE`. They are leaving; the date is the
  actionable fact, and for a future date both answers mean "still employed, do
  not disable". A worker on leave with no dates is unchanged. There is a test
  pinning this so it reads as a decision.

- **A mirror test guards the over-correction.** `'Terminated'` with a *past* date
  must still be `TERMINATED`. It passes both before and after — which is correct,
  and is why falsification shows 2 of 3 new tests flipping rather than 3.

## Unproven, and recorded as such

Whether real Workday actually emits a `terminat`-containing status alongside a
future termination date is an empirical question about live data. Task #114
records the operator decision to proceed without a sandbox, so it stays
unproven. The defect stands on its own: the code contradicted its stated rule and
no test covered the difference.
