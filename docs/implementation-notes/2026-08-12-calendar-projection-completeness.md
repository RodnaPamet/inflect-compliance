# 2026-08-12 — Calendar: a completeness guard that runs the other way

**Commit:** `<pending>` fix(calendar): project the two missing deadline columns, guard the rest

Two roadmap items. One of them turned out not to exist.

## #19: the blockers were already gone

The brief said two ratchets pinned `compliance-calendar.ts` to a single file and
had to be rewritten against the module's exports before it could be split:

- `tests/guards/epic49-calendar-ratchets.test.ts`
- `tests/guardrails/b3-button-card-unify.test.ts`

**Neither exists.** They were deleted by the epic-ratchet retirement sweep
CLAUDE.md documents — `epic49-…` in `c7a994a0` ("retire the shipped epic
ratchets"), `b3-…` in `170dadd9` ("retire b1-b9 batch ratchets"). Nothing pins
the file's shape today; the split is already unblocked. The only path-coupled
references left are three guards that read the file by path, and a directory
split (`compliance-calendar.ts` → `compliance-calendar/index.ts`) leaves every
import specifier untouched.

So "rewrite two ratchets, then split" collapsed to "split", and the split ships
as its own PR: a 1,755-line reorganisation with no behaviour change should be
reviewable in isolation, not folded in beside new projections.

What did survive from #19 is the **naming lie**.
`calendar-ux-completeness.test.ts` never checked projection completeness — its
assertions are the Gantt not pre-filtering, loading vs empty, one urgency
threshold, the heatmap window, deep-link resolution, create-from-calendar
discoverability. All UI chrome. It is now `calendar-ux-contract.test.ts`.
A name that promises a stronger invariant than the file enforces is worse than
no name: it makes the gap look covered, which is precisely how the gap below
survived.

## #21: the guard runs from the schema, not from a list

The old check verified that each NAMED loader exists — the direction that
cannot fail. Add a date-bearing entity, forget to project it, and nothing
happens. Two had already slipped through:

- **`AssetVulnerability.remediationDueAt`** — written by the vulnerability
  usecase and **edited by users** through an inline DatePicker on the asset's
  vulnerability list. Someone set a remediation date and then could not find it
  on the one surface whose job is "what is due".
- **`Audit.schedule`** — the day fieldwork on an audit begins. The *cycle* being
  on the calendar made this easy to miss: the surface looked like it covered
  audits already.

Both are now projected, as `vulnerability-remediation-due` and
`audit-scheduled`.

The new guard enumerates candidates from the **Prisma DMMF** and requires each
to be projected or listed in an exclusion map with a written reason. On its
first run it found **eight more** than the brief named — the point of running
it in the direction that can fail.

Most were easy: six `retentionUntil` clocks the data-lifecycle job acts on
without human intervention, and an external questionnaire token's lifetime.

One needed an actual decision. **`VendorMonitor.attestationExpiresAt`** *is*
acted on — the posture sweep re-checks it and flips the vendor into
reassessment-due. But that reassessment surfaces as
`VendorAssessment.nextReviewAt`, which is **already projected** as
`vendor-assessment-review`. Projecting both would double-report one obligation.
It is excluded as *the observation that drives a projected deadline*, which is
the kind of distinction a bare "not needed" would have destroyed.

## The urgency scale reached the jobs

`URGENCY_DAYS` was honoured by the calendar and the dashboard, while the literal
`[30, 7, 1]` lived in five job files. The ratchet claiming "one urgency
threshold set" checked the calendar and the dashboard and **never the job
path** — true of the two surfaces it looked at, false of the system, and unable
to tell the difference.

`DEFAULT_REMINDER_WINDOWS` is now derived from `URGENCY_DAYS` (written out as
literals it would be one more copy, just centrally located), the three job files
read it, and the ratchet checks them — stripping comments first, since a
docstring naming the default is documentation, not a second source of truth.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/compliance-calendar.ts` | two new loaders + registry entries |
| `src/app-layer/schemas/calendar.schemas.ts` | two source names, two event types, two entity types |
| `src/lib/urgency.ts` | `DEFAULT_REMINDER_WINDOWS`, derived |
| `src/app-layer/jobs/{deadline-monitor,calendar-deadlines,evidence-expiry-monitor}.ts` | read the shared windows |
| `tests/guardrails/calendar-projection-completeness.test.ts` | DMMF-driven; the guard this surface actually needed |
| `tests/guards/calendar-ux-contract.test.ts` | renamed; urgency assertions extended to jobs |

## Decisions

- **The exclusion map is the deliverable, not the escape hatch.** Ten of the
  eighteen entries are genuinely not deadlines. What makes the guard worth
  having is that excluding one now costs a written sentence, and a stale entry
  (column gone, or since projected) fails the ratchet.

- **A hand-enumerated test list silently stopped meaning what it said.** The
  "every source fails" case listed its 17 mocks inline; adding two sources
  turned it into "17 of 19 fail" — still green, no longer the assertion. It now
  derives from the same list `beforeEach` resets.

- **One claim is recorded as unverified.** The brief said two of the seventeen
  projected sources have no reminder job. The check I ran for it was too crude
  to trust (source names are not the strings the jobs use), and publishing a
  number I had not established would be worse than leaving it open.
