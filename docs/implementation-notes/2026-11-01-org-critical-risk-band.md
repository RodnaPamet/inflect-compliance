# 2026-11-01 — Organization "critical risk" follows each workspace's risk matrix

**Issue:** #4846

## Design

Owner decision (2026-11-01): a risk is critical for the organization portfolio
when its score is in **its own workspace's highest severity band**, and the
dashboard figure and the Critical Risks list both use that.

```
RiskMatrixConfig.bands (per workspace, Json)
        │  criticalScoreFloor()            src/lib/risk-matrix/critical-band.ts
        ▼                                  (pure; default grid → 15)
DashboardRepository.criticalScoreFloor(db, tenantId)
        │
        ├── countCriticalRisks(db, ctx) ──► snapshot.risksCritical
        │                                   (portfolio figure + health RAG)
        └── getCriticalRisksAcrossOrg / listCriticalRisksAcrossOrg
                                            (the drill-down list)
```

Both sides also filter on `needsTreatmentRiskStatusFilter()` (OPEN,
MITIGATING), so the list shows exactly the risks the figure counts.

## Files

| File | Role |
| --- | --- |
| `src/lib/risk-matrix/critical-band.ts` | Pure: lowest score of the band reaching the highest score |
| `src/app-layer/repositories/DashboardRepository.ts` | `criticalScoreFloor`, `countCriticalRisks` |
| `src/app-layer/jobs/snapshot.ts` | `risksCritical` from `countCriticalRisks` |
| `src/app-layer/usecases/portfolio.ts` | Both critical-risk queries use the workspace's floor |

## Decisions

- **Only the snapshot's `risksCritical` moves.** `getRiskBySeverity` keeps its
  fixed 1-4 / 5-9 / 10-14 / 15-25 tiers, because the workspace's own Risk
  Distribution card is drawn from them and a matrix can have any number of
  bands. So on a workspace with a custom matrix, the snapshot's
  `risksLow`..`risksHigh` and `risksCritical` no longer partition the risks.
  The only readers of the four together are the workspace's trend API and the
  digest email, which print them side by side, never summed.
- **The list drops ACCEPTED and MITIGATED risks.** It used `status != CLOSED`
  while the figure counted OPEN and MITIGATING only (the owner decisions of
  2026-10-29 and -30), so the two disagreed. Following the decision means
  both count the same risks.
- **The top band is the one reaching the highest score**, whatever its name,
  so a workspace that calls it "Severe" is read the same. An unreadable or
  empty `bands` falls back to the default grid's top band, as the matrix
  config read does.
- **Snapshots are not backfilled.** Past days keep the fixed-15 count; the
  next daily run (05:00 UTC) writes the new one, so a custom-matrix
  workspace's trend steps once on that day.
