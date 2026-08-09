# 2026-08-09 — Four risk panels move to `useTenantSWR`

**Commit:** `<pending>` refactor(risks): move four panels to useTenantSWR

## Design

Four panels on the Risks surface each hand-rolled their own fetch: a
`useEffect`, a `live`/`cancelled` flag, one or two `useState` slots, a
`.catch`, and — in two of them — a `reloadKey` counter that existed only so
the retry button could re-run the effect.

`useTenantSWR` already owns all of that: the request, the loading flag, the
error, deduping, and `mutate()` as the retry. The conversion is mostly
deletion.

| Panel | Was | Now |
|---|---|---|
| `dashboard/VelocityCard` | `fetch(...).catch(() => {})` | error card + retry |
| `[riskId]/RiskHistoryPanel` | effect + `failed` + `reloadKey` | `error` + `mutate()` |
| `[riskId]/BowTiePanel` | effect + `failed` + `reloadKey` | `error` + `mutate()` |
| `[riskId]/RiskAssessmentPanel` | two effects (suggestion + KRI breaches) | two `useTenantSWR` calls |

## The one behaviour change

`VelocityCard` swallowed its failure into `.catch(() => {})` and then did
`if (!v) return null`. A broken endpoint rendered **nothing** — which is
pixel-identical to the two states that legitimately render nothing:

- still loading;
- loaded fine, and there is genuinely no movement to report.

A card that renders nothing when it breaks is a card nobody ever reports as
broken, so the failure had no upper bound on how long it could persist. It
now renders an error card with a retry.

The two silent states stay silent. This is a supplementary dashboard slot,
and a skeleton for a card that may have nothing to say is worse than no
card. Only the error state is new, and
`tests/rendered/risk-velocity-card-error.test.tsx` asserts all three stay
distinguishable — including that the legitimately-quiet case does **not**
start showing an error just because the error state now exists.

## Decisions

- **`RiskAssessmentPanel`'s KRI-breach load stays failure-soft.** Its
  original comment says so explicitly: it hides the re-assess nudge rather
  than blocking the panel. That posture is preserved (the hook's `error` is
  not read) because this is a prompt to re-assess, not a control. The
  consequence is now written down at the call site: a failed load is
  indistinguishable from "no breaches".

- **The suggestion load keeps its status-bearing copy.** `ApiClientError`
  carries the HTTP status, so `assessment.failedLoadStatus` renders exactly
  as specific as the hand-rolled version. A non-HTTP failure (network,
  parse) has no status and falls back to the generic string — which is what
  the old `catch` produced too.

- **`setLoadError(null)` on retry is gone, not replaced.** SWR clears the
  error itself on a successful revalidate, so the extra state slot was
  redundant rather than load-bearing.

- **Write paths are untouched.** `RiskAssessmentPanel` still has five raw
  `fetch` calls; they are all POST/PATCH and belong to the separate
  `useTenantMutation` migration. Mixing the two would have made this diff
  unreviewable.

- **Tests needed per-render SWR cache isolation.** SWR's cache is
  module-global, so `tests/rendered/risk-assessment-panel.test.tsx` — which
  varies the KRI-breach fixture per case — was reading the previous test's
  cached response for the same URL. Every render is now wrapped in
  `<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>`.
  Any future rendered test of an SWR-backed component needs the same.
