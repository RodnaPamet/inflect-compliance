# 2026-08-09 — `RiskMatrix*` moves into `components/risks/`

**Commit:** `<pending>` refactor(risks): move RiskMatrix* into components/risks/

## What moved

`RiskMatrix.tsx` (659), `RiskMatrixCell.tsx` (465) and `RiskMatrixLegend.tsx`
(122) — 1,246 LOC — from `src/components/ui/` to `src/components/risks/`.
`components/risks/` now holds the whole family: the matrix trio,
`RiskScoreExplainer`, `RiskTreatmentPlanCard` and `RiskFirstRunEmpty`. There
are no risk-specific components left in `components/ui/`.

## Correcting the estimate that deferred this

The B2-5 note in `2026-08-09-risk-stat-tile.md` deferred this move, saying:

> **129 guards** glob `components/ui/**`. Those do **not** fail. They
> silently stop scanning 1,246 LOC.

**That was wrong, and it was wrong because it was inferred rather than
measured.** The 129 came from grepping the guard suite for the string
`components/ui` — which counts *mentions*, including guidance text like
"Use `<NumberStepper>` from `@/components/ui/number-stepper`" in an error
message. It is not a count of directory scanners.

Measured by performing the move and running the whole suite:

| | |
|---|---|
| Suites failing (explicit path match) | **8** — loud, one-line fixes |
| Suites silently losing coverage | **0** |
| Suites passing | 612 |

The silent-loss hunt was narrowed properly: of the guards with a numeric
ceiling (`toBeLessThanOrEqual` / `CAP` / `BASELINE`), only three touch
`components/ui` at all, and the only one with a true ceiling —
`epic60-ratchet` — scans `src/app/**`, not `components/`. It mentions
`components/ui` solely in a remediation hint. So no count could drop.

The eight that failed are the entire cost:

`no-lucide` · `focus-ring-offset-discipline` · `rq3-5-histograms` ·
`tenant-money-formatter` · `rq3-ob-e-a11y` · `rq3-ob-d-closed-loops` ·
`i18n-adoption-ratchet` · `rq2-5-coherence`

Each named the path in a `read()` call or a baseline/exemption array. One
line each.

## Decisions

- **`RiskMatrix` keeps its non-risk consumer and moves anyway.**
  `admin/risk-matrix/RiskMatrixAdminClient.tsx` imports it, which is why the
  earlier note called "zero consumers outside the risk domain" false. That
  correction still stands — but the admin matrix-config page is *about
  risk*, so `components/risks/` is the right home for a component both risk
  surfaces share. `components/ui/` is for cross-domain primitives, and a
  likelihood×impact matrix is not one.

- **The lesson is the method, not the number.** Deferring on an inferred
  cost was the mistake. The measurement — move it, run everything, then hunt
  specifically for ceiling-shaped assertions that could absorb a drop — took
  less time than writing the paragraph that deferred it.
