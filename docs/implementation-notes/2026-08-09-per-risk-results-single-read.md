# 2026-08-09 — One validated read of `perRiskResultsJson`

**Commit:** `<pending>` refactor(risks): consolidate the six narrowings of perRiskResultsJson (B2-6)

## Design

`RiskSimulationRun.perRiskResultsJson` is a Prisma `Json` column, so every
consumer receives `JsonValue` and has to narrow it. Six sites had done so
independently, and they did not agree:

| Site | How it narrowed | Admits a row with… |
|---|---|---|
| `monte-carlo.ts::getPerRiskPercentiles` | full `typeof` validation + mean fallback | `riskId` + `aleMean` |
| `risk-report.ts` | `Array.isArray` then `as Array<Record<string, unknown>>` | `riskId` + `aleP90` |
| `risks/board/page.tsx` | `as unknown as { riskId; aleP90? }[]` | anything |
| `MonteCarloPanel.tsx` (DTO) | `aleMean` **required** | — |
| `loss-events/page.tsx` (DTO) | `aleMean` **optional**, plus an `aleP50` the others lack | — |
| `dashboard/page.tsx` | consumes `SimulationRun` | — |

The three client DTOs describe an already-serialised API response and are
left alone; their divergence is a separate question. The three **server**
reads all start from the same untrusted `JsonValue`, and two of them skipped
the validation the third had bothered to write.

`src/lib/risk/per-risk-results.ts` is now the only place that column is
parsed. `parsePerRiskResults(json)` validates and indexes by `riskId`;
`buildTailByRisk(json)` is the P90 projection, built on top of it rather
than scanning separately — so the report and the board can no longer admit
different sets of risks from one run.

## Files

| File | Role |
|---|---|
| `src/lib/risk/per-risk-results.ts` | New. The canonical validated parse + the P90 projection. |
| `src/app-layer/usecases/monte-carlo.ts` | `getPerRiskPercentiles` delegates; `RiskTailPercentiles` re-exported so callers are unaffected. |
| `src/app-layer/usecases/risk-report.ts` | Weaker local reader deleted. |
| `src/app/t/[tenantSlug]/(app)/risks/board/page.tsx` | Blind cast deleted; stale-percentage denominator moved to the staleness slot's own total. |
| `src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx` | Local `useMemo` derivation replaced. |
| `tests/unit/risks/per-risk-results.test.ts` | New. 22 cases, covering exactly what the three readers disagreed about. |
| `tests/unit/risk-report-branches.test.ts` | Fixture corrected — see below. |
| `tests/guards/rq3-1-simulated-lec.test.ts` | Two source-pinning regexes replaced by a delegation assertion. |

## Decisions

- **Runtime validation, not a shared type.** A `Json` column has no schema
  the compiler can check, and rows written before RQ3-1 genuinely lack the
  percentile fields. A shared interface would have made all six sites *agree
  on a lie*; the parse makes them agree on a check.

- **`riskId` + `aleMean` are the admission rule.** One to key on, one to
  fall back to. `risk-report.ts` previously required `aleP90` instead, which
  meant a pre-RQ3-1 run — every field present except the percentiles —
  produced a tail column of nothing in the PDF while the board rendered
  numbers from the same run.

- **The fallback is per-field, not all-or-nothing.** A row with `aleP90` but
  no `aleP95` keeps its real P90 and reports the mean for P95, leaving
  `p50 === p90 === mean` as the "no tail" signal `tail-language.ts` already
  keys off.

- **`risk-report-branches.test.ts` had an impossible fixture.** It asserted
  a row of `{ riskId, aleP90 }` with no `aleMean` was mapped. The writer
  cannot produce that: `monte-carlo.ts` types `perRisk` with
  `aleMean: number` and computes it unconditionally from the sample sum. The
  fixture was corrected rather than the parse loosened, and the corrected
  version now also pins the degrade-to-mean branch the old reader dropped.

- **Two source-pinning regexes in `rq3-1-simulated-lec` were retired**, not
  relocated. They asserted the characters `typeof e.aleP50 === 'number' ?
  e.aleP50 : e.aleMean` appeared in a file — which proves the text exists,
  not that the fallback works. The behaviour is now covered directly, and
  mutation-testing confirms the new test fails when the fallback is removed
  and when the `aleMean` guard is dropped. Consistent with the ratchet
  lifecycle policy (B3-6).

- **The board's stale-percentage denominator moved** from `risks.length` to
  `staleness.totalCount`. Same number today — both count all non-deleted
  risks — but they are different queries, and the dashboard's `listRisks`
  is an unbounded `findMany`. Adding a `take:` to it as a perf fix would
  have silently inflated the percentage while the slot's own total stayed
  right.

- **What was NOT extracted.** The roadmap item also proposed sharing
  `TopContributorsList` and an `AppetiteChip` between the two pages. Neither
  survives inspection: the board renders a semantic ranked `<ol>` linking to
  `?tab=assessment` while the dashboard renders whole-row links to the risk,
  and the dashboard has no appetite chip at all — it passes `appetite`
  through to `MonteCarloPanel`. Forcing either into a shared component would
  have added a props-driven branch to paper over a difference that is
  intentional.
