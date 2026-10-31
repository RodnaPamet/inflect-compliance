# 2026-10-31 — SOC 2 and NIS2 estimate folded into ISO 27001's Coverage tab

**Commit:** see the pull request that adds this note.

## Design

`/t/:slug/mapping` was a page of its own. It showed, for every SOC 2 criterion and NIS2 area, how far the workspace's ISO 27001 controls go towards it. The figure came from the fixed guidance table that relates Annex A controls to those criteria (`getFrameworkMappings` in `usecases/mapping.ts`). Nothing linked to the page, and it read as real coverage. #4737 labelled it as an estimate and linked it from ISO 27001's page. The owner then decided (2026-10-31) to drop the separate page.

The estimate is now `IsoEstimatePanel`, rendered on ISO 27001's Coverage tab below "Coverage from your other frameworks". It sits there because it is the same kind of figure: what your controls on one framework imply for another.

```
frameworks/[frameworkKey]/page.tsx — Coverage tab
  ├─ direct coverage (computeCoverage)
  ├─ InheritedCoveragePanel        (imported mapping sets)
  └─ IsoEstimatePanel              (ISO 27001 only; GET /mapping)
        shows soc2 / nis2 only where inUse[framework] is false
```

`getFrameworkMappings` now also returns `inUse: { soc2, nis2 }`. Each flag is the Frameworks page's own "Installed" rule, `isFrameworkInUse`, asked of both catalogue keys (`SOC2`/`SOC2-2017`, `NIS2`/`NIS2-2022`). Once a framework is in use, its own page has the real coverage, so its estimate leaves the panel. With both in use the panel renders nothing.

## Files

| File | Role |
| --- | --- |
| `src/components/frameworks/IsoEstimatePanel.tsx` | The panel: per framework, criteria related to a control and the average estimate over those criteria; criteria in an accordion |
| `src/app-layer/usecases/mapping.ts` | `inUse` flags beside the readiness folds |
| `src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/page.tsx` | Mounts the panel on ISO 27001's Coverage tab; the header link to `/mapping` is gone |
| `src/lib/compliance/iso27001-clauses.ts` | `isIso27001Framework`, which the clause-tracker check now reads |
| `src/app/t/[tenantSlug]/(app)/mapping/page.tsx` | Deleted |
| `messages/*.json` | `mapping.*` moved to `frameworks.detail.isoEstimate.*`; `nav.mapping`, `common.sections.mapping` and `frameworks.detail.mappingEstimate` removed |

## Decisions

- **The API routes stay.** `GET /api/t/:slug/mapping` feeds the panel. The legacy `/api/mapping` is untouched because removing it is a separate, API-facing change.
- **The average excludes criteria with no related control.** Counting them as 0% would read as "not implemented" when the guidance relates nothing of yours to them. #4737 made the same call for the per-criterion figure.
- **No redirect from `/mapping`.** Nothing linked to it before #4737, and #4737's link lived for a day, so a redirect would keep a route alive for bookmarks nobody has.
