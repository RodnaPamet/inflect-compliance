# 2026-10-30 — the Board leaves mitigated risks out of its severity figures

**Commit:** `fix(dashboard): the Board's severity figures leave out mitigated risks`

## Design

#4496 named the line between open and settled risks once, in
`src/app-layer/domain/risk-status.ts`: open is anything not CLOSED or
ACCEPTED. The Board's severity figures took that line. The owner's decision
of 2026-10-30 moves the Board alone to a narrower one: a MITIGATED risk has
had its treatment, so it is no longer exposure.

The module now places each status in one of three stages, in one exhaustive
map keyed on `RiskStatus`:

```
OPEN, MITIGATING  → needsTreatment
MITIGATED         → awaitingAcceptance
ACCEPTED, CLOSED  → settled

OPEN_RISK_STATUSES            = not settled      (OPEN, MITIGATING, MITIGATED) — unchanged
SETTLED_RISK_STATUSES         = settled          (ACCEPTED, CLOSED)            — unchanged
NEEDS_TREATMENT_RISK_STATUSES = needsTreatment   (OPEN, MITIGATING)            — new
```

Two lines for two questions. "Is anything still due on this risk?" is the
open line: a mitigated risk still has a review date and an acceptance call, so
the deadline monitor and the compliance calendar keep it. "How much risk is
still exposed?" is the needs-treatment line, and the Board now reads it.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/domain/risk-status.ts` | the three-stage map; `NEEDS_TREATMENT_RISK_STATUSES`, `needsTreatmentRiskStatusFilter`, `riskStatusNeedsTreatment` |
| `src/app-layer/repositories/DashboardRepository.ts` | `getStats.highRisks` and `getRiskBySeverity` filter on the new grouping |
| `src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx` | the donut slices' `status=` filter |
| `src/components/ui/next-best-action-logic.ts` | the next-step link's spelled-out query |
| `src/app-layer/usecases/risk-snapshot.ts`, `automation-suggestions.ts` | name the grouping they already spelled inline; same set |
| `docs/user/guide/overview/dashboard.md` | the help guide |

## Decisions

- **One map, three stages, rather than a second map.** A second
  `Record<RiskStatus, boolean>` would also fail `tsc` on a new status, but the
  two maps could then disagree about a status's place (needing treatment but
  settled). One map cannot.
- **The deadline monitor and the calendar do not move.** Moving them would
  drop a mitigated risk's review from reminders and show it as done on the
  calendar, which the decision does not ask for. The real-DB test holds both.
- **The snapshot and the suggestions change no behaviour.** Each spelled
  exactly OPEN + MITIGATING, so pointing them at the constant is a rename. The
  same test fixture pins their counts.
- **The daily dashboard snapshot steps down.** `risksLow`..`risksCritical` are
  written from `getRiskBySeverity`, so from the first snapshot after deploy a
  tenant with mitigated risks reads lower in those series: the org portfolio's
  "critical risks" widget and the weekly digest's severity line. This is the
  decision applied where its figures are stored, as #4496's step was.
- **The Risk axis can go empty.** A tenant whose every risk is mitigated,
  accepted or closed has no estate on the posture radar's Risk axis, so it
  reads "None yet" and leaves the chart. The guide says so.
- **The on-screen copy is unchanged.** "Open risks" in the next-step
  description and the "high/critical" subtitle still read correctly for Open
  and Mitigating risks. The owner's own wording calls these the Board's "open
  high/critical figures".
