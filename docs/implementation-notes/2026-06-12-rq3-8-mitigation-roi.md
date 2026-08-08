# 2026-06-12 — RQ3-8 — Mitigation ROI: what does €1 of control buy?

**Commit:** `pending` (branch `claude/rq3-8-mitigation-roi`)

## Design

The decision layer of the quantitative stack. A program with FAIR-quantified
risks (RQ3-2) and a residual derivation (RQ2-2) still cannot answer the only
question that funds it: *which control buys the most ALE reduction per €?*
RQ3-8 closes that gap with three load-bearing additions:

1. **`Control.annualCost Float?`** — the operate + maintain spend per year, in
   the tenant's currency. Nullable on purpose: a control that has not been
   priced yet returns a typed `NO_COST` gap rather than a fabricated zero.
2. **Pure ROI math** at `src/lib/control-roi.ts` — `computeControlRoi(...)`
   returns a tagged-union verdict: `{ ok: true, value: { aleProtected,
   roiMultiple, … } }` or `{ ok: false, reason: 'NO_COST' | 'NO_EFFECTIVENESS'
   | 'NO_QUANT_RISKS' }`. No `0` row escapes.
3. **Two read surfaces** — a single-control detail card (the buyer's
   "what does this one cost vs. buy" decision) and a portfolio leaderboard
   ("best-value controls", capped at 25, bounded loader).

### Model

For each linked risk `r` where `inherentAle(r)` is computable (FAIR → fairAle
preferred; else SLE × ARO via the existing `resolveALE`):

```
aleProtected_r = inherentAle_r × (effectiveness / 100)
totalProtected = Σ aleProtected_r
roiMultiple    = totalProtected / annualCost
```

Per-control valuation rather than a portfolio simulation. Layered-control
double-counting is avoided by treating each control as if it were applied
*at its declared effectiveness on each quantified linked risk*. The ratio
is easy to explain on the surface ("X% of Y risks' ALE divided by your
annual cost") — the model is conservative, but its conservatism is honest
about its own limits.

### Honest-null contract

Three reasons cover the legitimate absences:

- `NO_COST` — `annualCost` is null or ≤ 0.
- `NO_EFFECTIVENESS` — `Control.effectiveness` is null (no DECLARED or
  MEASURED signal exists).
- `NO_QUANT_RISKS` — every linked risk lacks an ALE (or the control has zero
  linked risks).

Each maps to a typed UI nudge via `describeRoiGap(...)`. The ratchet at
`tests/guards/rq3-8-mitigation-roi.test.ts` locks every non-ok branch + the
`rankByRoi` filter so a future "stable order" refactor cannot slot un-priced
controls into the leaderboard at the bottom with a synthetic zero.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/compliance.prisma` | `Control.annualCost Float?` |
| `prisma/migrations/20260612120000_rq3_8_control_annual_cost/migration.sql` | DDL |
| `src/lib/control-roi.ts` | Pure math + verdict union + `rankByRoi` + `describeRoiGap` |
| `src/app-layer/usecases/control-roi.ts` | `getControlRoi` (single) + `getBestValueControls` (batched, capped) |
| `src/app/api/t/[tenantSlug]/controls/[controlId]/roi/route.ts` | GET single control verdict |
| `src/app/api/t/[tenantSlug]/controls/best-value/route.ts` | GET leaderboard (limit param) |
| `src/lib/schemas/index.ts` | `UpdateControlSchema.annualCost` |
| `src/app-layer/usecases/control/mutations.ts` | `updateControl` passes `annualCost` through |
| `src/lib/dto/control.dto.ts` | List/Detail DTO adds `annualCost` + `effectiveness` |
| `src/app/t/[tenantSlug]/(app)/controls/[controlId]/_components/ControlRoiCard.tsx` | Detail-page card with the ok/gap branches |
| `src/app/t/[tenantSlug]/(app)/controls/_components/BestValueControls.tsx` | Aside rail leaderboard with honest-null empty-state |
| `src/app/t/[tenantSlug]/(app)/controls/[controlId]/_modals/EditControlModal.tsx` | `<NumberStepper>` field for `annualCost` |
| `src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx` | Mounts the ROI card on the overview tab; threads `annualCost` through the edit form |
| `src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx` | Mounts the best-value aside panel |
| `tests/unit/control-roi.test.ts` | 14 pure-math assertions on the honest-null contract |
| `tests/unit/control-roi-usecase.test.ts` | 7 loader assertions (batched findMany, bound, drops un-priced) |
| `tests/integration/control-roi.test.ts` | 4 DB-backed assertions (FAIR + SLE×ARO + leaderboard) |
| `tests/rendered/control-roi-card.test.tsx` | 4 UI assertions on the ok/gap branches |
| `tests/guards/rq3-8-mitigation-roi.test.ts` | 12 structural ratchets |

## Decisions

- **`Float?` not `Decimal?`.** The existing money fields on Risk
  (`sleAmount`, `aroAmount`, `fairAle`, `revenueAtRisk`) are all `Float?`.
  Matching that pattern keeps the read-path simple (number arithmetic
  end-to-end, no Prisma `Decimal.toNumber()` calls scattered through the
  UI). Currency precision drift at the float boundary is acceptable for an
  annualised ROI ratio — the display rounds aggressively (`formatCompactCurrency`
  gives `€25K` / `€1.2M`).
- **Per-control valuation, not per-portfolio simulation.** A Shapley /
  leave-one-out allocation across the layered residual is more rigorous but
  the conservatism cost is real: a single control's contribution always
  depends on the slate, the slate changes on every link/unlink, and the
  number becomes hard to explain at the surface. The simple model is
  defensible *because* it is local — comparing two controls' ROI compares
  them on the same yardstick.
- **`NO_QUANT_RISKS` collapses the two "no risks" reasons.** A control with
  zero linked risks and a control with three un-quantified linked risks
  produce the same verdict reason but different `describeRoiGap` copy —
  the first says "link this control to a risk first", the second says
  "quantify the linked risks (SLE × ARO or FAIR)". Same reason code, copy
  varies on `linkedRiskCount`. Keeps the type union narrow without losing
  the nudge specificity.
- **`BEST_VALUE_HARD_CAP = 25`** clamps a caller-supplied limit so an
  attacker (or a buggy client) cannot DoS the ranking path with `limit=1e6`.
  Combined with the `take: 500` on the `findMany`, a tenant with 50k
  controls still pages a bounded slice into memory before the rank.
- **Aside panel, default-collapsed.** Mounting the leaderboard inline on
  the controls list would push the table down for every tenant — including
  those who have zero priced controls. Living in the existing aside rail
  (alongside Browse + AI Assist) keeps the list page's read order intact
  and lets the leaderboard self-render its empty-state without leaking
  noise onto the table-card real-estate.
- **`<NumberStepper>` over `<input type="number">`.** Epic 60 ratchet
  blocked a fifth raw number input; the stepper primitive handles
  empty-string → `0` → "unpriced" cleanly via the `v <= 0 ? '' : ...`
  bridge in the form-state, so the save handler still ships `annualCost:
  null` for unpriced and preserves the honest-null wire contract.
