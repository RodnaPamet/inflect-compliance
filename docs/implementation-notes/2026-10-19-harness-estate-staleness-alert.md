# 2026-10-19 — A stale scanner estate raises a finding and a metric (4a follow-up)

**Commit:** `feat(agentic): a stale scanner estate raises a finding and a metric (#3741)`

## Design

Owner decision of 2026-10-19 on #3741: a stale estate must alert, not only show
on the harness tab's health card. A silent scanner is a monitoring gap, and
"fail closed, never silently" applies to it.

```
06:47 UTC  agent-harness-estate-staleness  (schedules.ts states the minute)
  jobs/agent-harness-estate-staleness.ts
    discover tenants: an estate ∪ an unrevoked scanner key ∪ an open STALE_ESTATE finding
    per tenant ─▶ usecases/agent-harness-estate-staleness.ts   (one transaction)
                    advisory lock  harness-estate-staleness:<tenantId>
                    estates + sources                     (drained)
                    scans inside each estate's window     (drained; asOf AND createdAt >= freshnessWindowStart)
                    STALE_ESTATE:* findings, CLOSED too   (drained)
                    computeEstateHealth  ◀── lib/agentic/harness-estate-health.ts (the ONE rule)
                    planEstateStaleness  ◀── lib/agentic/harness-estate-staleness.ts (pure)
                    OPEN / REOPEN / STILL_OPEN / CLOSE / HOLD  via FindingRepository + logEvent
                    IntegrationExecution  agentic.harness_estate_staleness
                  ─▶ recordHarnessEstateStaleness  (agentic.harness_estate.{pass,evaluated,stale})
```

**One rule.** The pass calls `computeEstateHealth`, the function the card runs.
The planner reads the row's verdict and never re-derives one. The only new
export in the health module is `freshnessWindowStart`, the boundary the rule
already used, now named so the pass can bound its read by it. A scan counts from
`min(asOf, ingestedAt)`, and a minimum is at or after a bound exactly when both
operands are, so `asOf >= start AND createdAt >= start` selects precisely the
scans that can make an estate fresh.

**One finding per estate**, `sourceKind = AGENT_HARNESS`,
`sourceRef = STALE_ESTATE:<estateId>`: stale with none opens one, stale with a
CLOSED one reopens it (title and description restated), stale with an open one
does nothing.

**It closes only when a complete scan arrives.** Without an edit, time cannot
turn a STALE row FRESH: the window only moves forward. With one, it can. Raising
the cadence widens the window around an old scan, and dropping a declared
source makes an older scan complete for the sources left. So a FRESH row closes
the finding only when its last complete scan was INGESTED after the declaration
last changed: the estate row's `createdAt`/`updatedAt` or any source row's, since
an edit replaces the sources as a set. Otherwise the finding is held
(`FRESH_ONLY_BY_DECLARATION_CHANGE`). A removed estate is not evaluated, and its
open finding is held (`ESTATE_NOT_DECLARED`). Both are named on the run's row.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/harness-estate-health.ts` | `freshnessWindowStart`, which the rule's own freshness test now uses |
| `src/lib/agentic/harness-estate-staleness.ts` | the pure planner: ref key, stale reason, finding text, actions |
| `src/app-layer/usecases/agent-harness-estate-staleness.ts` | one tenant's pass: read, judge, reconcile, record |
| `src/app-layer/jobs/agent-harness-estate-staleness.ts` | tenant discovery, the sweep, the BullMQ body |
| `src/app-layer/jobs/{types,schedules,executor-registry}.ts` | payload, one attempt, 06:47 UTC, registration |
| `src/lib/observability/integration-metrics.ts` | `recordHarnessEstateStaleness` |
| `tests/unit/agentic/harness-estate-alert-uses-the-health-rule.test.ts` | the alert imports and calls the rule and holds no copy of it |

## Decisions

- **The read is the pass's own, not `getHarnessEstateHealth`.** The card's read
  caps estates at 50 and shares one newest-500 scan window across every
  scanner. A job must not cap silently, and in a shared window one chatty
  scanner can push another estate's last complete scan out, which would make it
  look stale. That is the right failure for a card that labels the window, but
  wrong for a finding. Per-estate windows, drained, avoid both. The verdict is
  still the card's function.
- **A stale reason is reported, not judged.** `SCANNER_NOT_LIVE`,
  `NO_SCAN_IN_WINDOW` and `NO_COMPLETE_SCAN` are read off the row and the
  window, so an operator knows whether to restore a scanner, chase a silent one
  or fix a source. They are the metric's only label.
- **`HIGH` OBSERVATION, the `EMPTY_SCAN` precedent.** Both mean the estate's
  inventory is not currently evidenced. It is an observation, not a
  nonconformity, because the gap is in monitoring and not yet in the estate.
- **The scanner's owner is the assignee** while they are an ACTIVE member. The
  scanner is the thing that went quiet, and the register says whose it is.
  Source owners are already named on the card.
- **PASSED means every estate was judged**, as on the other agentic passes. The
  findings and `agentic.harness_estate.stale` say what was stale. A tenant with
  no estate is `NOT_APPLICABLE` with `evaluated: 0`, so zero stale of zero
  evaluated is never a pass.
- **The execution row is written in the findings' transaction**, so a run row
  and the findings it describes commit together. The ERROR row is written in a
  fresh one.
- **A per-tenant advisory lock**, namespaced away from the audit chain's own,
  makes a scheduled tick and a manual run serialise. The second sees the first's
  finding instead of opening another; the integration test runs two at once.
- **A scanner key alone brings a tenant into the sweep.** A tenant that trusts a
  scanner but declares no estate has scans nobody measures against a cadence,
  and its daily `NOT_APPLICABLE` row says so. A tenant that never used the
  harness is not visited.
- **06:47 UTC.** Scanners run on their own anchors, so no minute is after all
  of them, and the rule already tolerates half a cadence of lateness. The slot
  sits after the 06:30 evidence emission, which also reads scans, and away from
  06:00, where two other agentic passes raise findings. No other entry fires at
  :47, frequent ticks included.
- **No migration.** Findings carry the key and the execution row carries the
  run. The closing evidence is computed from columns that already exist.
- **The shared key space is checked, not assumed.** `STALE_ESTATE` is not one
  of `HARNESS_FINDING_CODES`, and the unit suite runs the ingest's planner to
  show it never emits that prefix.
