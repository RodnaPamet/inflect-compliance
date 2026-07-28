# 2026-07-27 — Dashboard trim + swappable-KPI fold

**Commit:** `<pending> feat(dashboard): fold Evidence Status / Exceptions / Treatment Plans into the custom-KPI slot, remove Compliance Alerts + Risk Matrix + Evidence Expiry`

## Design

The executive dashboard grew a long tail of standalone cards below the
fixed KPI grid. Six of them were pruned in two ways:

**Removed entirely** — Compliance Alerts, Risk Matrix (heatmap), Evidence
Expiry (calendar). These duplicated signal already carried elsewhere (the
fixed stat tiles, the risk pages' own matrix, the compliance calendar) and
cost per-load compute on the dashboard's hot path.

**Folded into the on-demand swappable-KPI slot** — Evidence Status,
Exception Inventory, Treatment Plans. The dashboard already had a
"custom KPI" dropdown (`CustomKpiPanel`) backed by
`getDashboardKpi(ctx, key)` — a single KPI catalog where each entry renders
a headline number + a status donut, loaded **only when the user picks it**.
The three folded cards became three new catalog keys (`evidence`,
`exceptions`, `treatmentPlans`) alongside the existing `assets` / `audits` /
`tests`.

The load-bearing constraint was the **compute-render gap** invariant
(guarded by `tests/guards/dashboard-compute-render-gap.test.ts`): the
executive payload must not compute anything the client never renders.
`getExecutiveDashboard` used to compute `riskHeatmap`, `upcomingExpirations`,
`exceptions`, and `treatmentPlans` every load. Folding the three cards to the
on-demand path (which calls the repo summaries directly) would have orphaned
those four aggregates in the always-on payload. So they were **removed from
`getExecutiveDashboard`** and the payload type. `evidenceExpiry` stayed —
it is still read server-side by `compliance-posture.ts` (the masthead hero)
and by the daily `snapshot` job.

Donut hygiene: the source summaries have overlapping buckets
(`dueSoon30d ⊇ dueSoon7d`, `expiringWithin30 ⊇ expiringWithin7`, both ⊆
`activeApproved`). The old horizontal-breakdown cards double-counted those.
Rendering them as a **pie** made the overlap visually wrong, so each folded
KPI carves disjoint slices (`Due 8–30d = dueSoon30d − dueSoon7d`, etc., all
`max(0, …)` guarded) whose values partition the headline exactly.

Separately, the "Developing" compliance-posture label now renders with the
primary button's yellow→blue fill gradient
(`bg-[image:var(--btn-gradient-primary)] bg-clip-text text-transparent`) —
the same `--btn-gradient-primary` token the "Continue Setup" onboarding CTA
fills with, tying the "still building" posture band to the setup call-to-action.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/dashboard.ts` | +3 keys in `SWAPPABLE_KPI_KEYS`; +3 cases in `getDashboardKpi`; trimmed 4 aggregates from `getExecutiveDashboard` |
| `src/app-layer/repositories/DashboardRepository.ts` | Dropped `riskHeatmap`/`upcomingExpirations` from the payload type; deleted `getRiskHeatmap`/`getUpcomingExpirations` + `RiskHeatmapCell`/`EvidenceExpiryItem` types |
| `src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx` | Deleted 5 card components + 2 dynamic imports + `matrixConfig` prop; +3 `SWAPPABLE_KPI_META` entries + dropdown options |
| `src/app/t/[tenantSlug]/(app)/dashboard/page.tsx` | Dropped the `getRiskMatrixConfig` fetch + `matrixConfig` prop |
| `src/app/t/[tenantSlug]/(app)/dashboard/PostureHeroCard.tsx` | "Developing" label → gradient-clipped text |
| `messages/{en,bg}.json` | +3 `customKpi.*` dropdown labels |

## Decisions

- **Kept the repo summary methods, dropped the payload fields.**
  `getEvidenceExpiry` / `getExceptionSummary` / `getTreatmentPlanSummary`
  survive because `getDashboardKpi` now calls them on demand;
  `getRiskHeatmap` / `getUpcomingExpirations` had no other caller and were
  deleted outright.
- **Server-side English segment labels.** The folded KPIs return English
  segment labels (`'Overdue'`, `'Active'`, …) from the usecase, matching the
  pre-existing `assets`/`audits`/`tests` cases. Only the dropdown/tile label
  is i18n'd (`customKpi.*`). The old cards' `dashboard.exceptions.*` /
  `treatmentPlans.*` / `evidenceStatus` keys are now unused-in-source but
  left in place (harmless; en↔bg parity preserved — the i18n-completeness
  ratchet only flags locale-vs-en orphans).
- **Disjoint pie slices over faithful replication.** Reproducing the old
  overlapping breakdown would have shipped a visibly-wrong donut; the
  partitioned buckets are a net correctness improvement made in the same pass.
- **Guard updates, not guard bypasses.** Six structural tests asserted the
  removed rendering; each was rewritten to assert the new end-state (compute
  surfaced via the swappable slot, payload trimmed) rather than deleted
  wholesale.
