# 2026-11-12 — #5442: coverage name lists, residual suggestion and trashed links

**Commit:** `fix(traceability): coverage name lists honour view keys; trashed items leave every traceability list and the residual suggestion (#5442)`

The three follow-ups that #5376 part C (#5438) left for an owner decision,
decided on #5442 on 2026-11-12. Built on part C's helpers (`canReadRisks`,
`canReadAssets`, `canReadControls`, `sideIf`) and its `deletedAt: null`
relation-filter pattern.

## Design

**1. The coverage dashboard's name lists answer to each view key.**
`coverageSummary` keeps its coarse `assertCanRead` gate and every count. The
three lists that carry names are omitted per kind, and their query is not run:

```
unmappedRisks            (risk titles)     needs risks.view
uncoveredCriticalAssets  (asset names)     needs assets.view
hotControls              (control names)   needs controls.view
```

The payload gains `withheld: { risks, assets, controls }`. The Coverage page
reads it: a withheld list with a non-zero total shows "Your role cannot view
risks/assets…" instead of "All risks are mitigated by controls", and drops the
"Showing 0 of N — View the risks" line. Without that, an omitted list would
have rendered as a false all-clear next to a badge counting 40.

**2. The residual suggestion ignores trashed controls.** `loadResidualSuggestion`
read the risk's controls through a nested select, which the soft-delete
extension does not reach. It now carries `where: { control: { deletedAt: null } }`.
`acceptResidualSuggestion` and `completePlan` (risk-treatment-plan) persist from
the same loader, so neither can write a residual a trashed control lowered.

**3. Trashed items leave every traceability list.** Risk, Control and Asset are
all in `SOFT_DELETE_MODELS`, so every list whose far side is one of them takes
the predicate:

| Read | Far side filtered |
| --- | --- |
| `ControlRiskRepository.listByControl` | `risk.deletedAt` |
| `AssetControlRepository.listByAsset` / `listByControl` | `control.deletedAt` / `asset.deletedAt` |
| `AssetRiskRepository.listByAsset` / `listByRisk` | `risk.deletedAt` / `asset.deletedAt` |
| `getPolicyTraceability` | the policy's controls, and the risks and assets inherited through them |
| `AssetRepository.getById` (asset page) and the list `_count.controls` (Controls column) | `control.deletedAt` |
| `computeAssetRollups` (asset page Risks / Controls counts) | both |
| `riskListSelect.assetLinks` + `_count.assetLinks` (risk list Asset column) | `asset.deletedAt` |

`ControlRiskRepository.listByRisk`, `RiskRepository.getById` and the risk list's
Controls column were part C.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/traceability.ts` | `coverageSummary` omits name lists per kind and returns `withheld`; policy view drops trashed items |
| `src/app/t/[tenantSlug]/(app)/coverage/CoverageClient.tsx` | Withheld list never reads as "all covered" |
| `messages/en.json`, `messages/bg.json` | `coverage.emptyRisksWithheld`, `coverage.emptyAssetsWithheld` |
| `src/app-layer/usecases/risk-residual-suggestion.ts` | Loader skips trashed controls |
| `src/app-layer/repositories/TraceabilityRepository.ts` | Five list reads filter the far side |
| `src/app-layer/repositories/AssetRepository.ts` | Detail include and Controls `_count` skip trashed controls |
| `src/app-layer/usecases/asset.ts` | Asset rollup counts skip trashed risks and controls |
| `src/app-layer/repositories/RiskRepository.ts` | Asset column skips trashed assets |

## Decisions

- **`withheld` is explicit rather than inferred.** "Empty list, non-zero total"
  is today exactly the withheld case, but an API consumer of
  `GET /coverage` should not have to know that; the flag also costs nothing a
  reader could not already see (it names the caller's own permissions).
- **Hot controls are a name list.** Each entry is a control's code and name
  with its risk count; the risk count is not one of the dashboard's totals, so
  the whole entry goes. The section already hides itself when empty.
- **A trashed control is no path for the policy view.** The risks and assets a
  policy inherits are reached only through its live controls; the inherited
  lists also drop trashed risks and assets themselves.
- **Counts follow the lists.** The asset page's Risks / Controls counts, the
  asset list's Controls column and the risk list's "+N assets" would otherwise
  disagree with the lists beside them; part C did the same for the risk list's
  Controls column.
- **Left alone:** `coverageSummary`'s totals still count links whose other side
  is in the trash (`risksWithControls` and friends read the join tables, and
  `hotControls` can rank a trashed control, whose entry then has no name). The
  owner's decision kept the totals unchanged; changing what they count is a
  separate decision.
