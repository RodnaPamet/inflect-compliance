# 2026-08-09 — The risk stat tile, and the matrix that stays separate

**Commit:** `<pending>` refactor(risks): extract StatTile from 20 copies

## The tile

`rounded-md bg-bg-muted/30 px-default py-default` appeared as **20 literal
copies** across four files — dashboard 8, loss-events 6, MonteCarloPanel 4,
RiskHistoryPanel 2. The kind of duplication a reader cannot see: nothing
names it, so nothing tells you the other 19 exist when you adjust one.

`_shared/StatTile.tsx` is now that markup, once.

### Why not `MetricCard` / `KpiCard`

Those primitives exist and are the right answer for a *card*. They are
richer components — their own border, heading slot, trend affordance and
padding scale — so swapping these tiles onto them would change how every one
of these surfaces looks.

`StatTile` is deliberately the minimal wrapper that matches the existing
markup **exactly**, so the dedupe is invisible in the rendered output.
Choosing the richer primitive is a design decision; it should be made on
purpose, in a diff that shows the visual change, not smuggled in under a
refactor. `tests/rendered/risk-stat-tile.test.tsx` asserts the class strings
verbatim — normally a smell, but here the class string *is* the contract
being preserved.

### The `/20` vs `/30` discrepancy is preserved, not fixed

18 tiles used `bg-bg-muted/30`; the two in `RiskHistoryPanel` used `/20`.
That is almost certainly drift rather than intent — but "almost certainly"
is not a licence to restyle two tiles inside a deduplication commit. Both
opacities survive as `tone="default"` / `tone="subtle"`, and the discrepancy
is now visible at the call site instead of buried in a class string, so it
can be settled deliberately.

## The third matrix renderer: NOT consolidated

The B2-7 item also flagged `correlations/page.tsx` as a third matrix
renderer alongside `RiskMatrix` and the dashboard heatmap, and asked for a
decision on whether it is genuinely the same artefact. It is not:

| | Risk matrix / heatmap | Correlation matrix |
|---|---|---|
| Axes | likelihood × impact — two fixed ordinal scales | risk × risk — N×N, symmetric, grows with the register |
| Cell | a count of risks in that band | a correlation coefficient, −1…1 |
| Colour | the tenant's configured band | coefficient magnitude |
| Interaction | drill into the risks in a cell | edit the coefficient, upper triangle only |

They are both "a grid of coloured cells", and that is where the similarity
ends. Merging them would produce one component behind a props union covering
two different dimensionalities, two cell semantics and two interaction
models — strictly worse to read than two renderers that each do one thing.

Recorded here so the next person who notices the surface similarity does not
have to re-derive the answer.

## Two risk components move to `components/risks/`

`RiskScoreExplainer` (229 LOC) and `RiskTreatmentPlanCard` (763 LOC) sat at
the `components/` root with only `/risks/` consumers. They now live in
`components/risks/`, beside `RiskFirstRunEmpty`, which is where a new risk
component should go.

### What was NOT moved, and why

The B2-5 item asked for 2,758 LOC across four namespaces. Measured, that is
wrong in three ways:

- **`AleHistogram` and `LossExceedanceCurve` do not exist.** `find src -name
  "AleHistogram*" -o -name "LossExceedanceCurve*"` returns nothing. 520 of
  the claimed LOC are not there.
- **"Zero consumers outside the risk domain" is false for `RiskMatrix`.**
  `admin/risk-matrix/RiskMatrixAdminClient.tsx` imports it. It is shared
  between the risk register and the admin matrix-config surface.
- Actual movable total is 2,238 LOC, of which 1,246 is the `RiskMatrix`
  family.

`RiskMatrix*` stays in `components/ui/` for now, and the reason is the
ratchet exposure — which is worse than "enumerate them first" implies:

- **8 guards** path-match `components/ui/RiskMatrix` explicitly. Those fail
  on a move. Loud, and therefore fine.
- **129 guards** glob `components/ui/**`. Those do **not** fail. They
  silently stop scanning 1,246 LOC. A budget or count ratchet whose
  denominator quietly shrinks is worse than a broken one — it keeps passing
  while covering less. Each needs triage to distinguish "this rule genuinely
  scopes to the `ui/` primitive layer" from "this rule wants all components
  and happens to be written against `ui/`".

The benefit here is organisational — it answers "where does a new risk
component go?" — with no functional payoff. That does not justify silently
reducing 129 guards' coverage as a side effect. The two root-level
components carry none of that exposure, so they move; the matrix family
waits for the triage to be done as its own piece of work.
