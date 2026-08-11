# 2026-08-11 — Adding the first test for a page can turn the coverage gate red

Follow-up to `2026-08-11-risks-write-permission-gates.md`, which went green on
its PR and turned `main` red on the `Coverage (≥60%)` gate.

## What happened

The permission-gate PR added `tests/rendered/risk-write-permission-gates.test.tsx`,
which mounts `risks/loss-events/page.tsx` and `risks/scenarios/page.tsx` — two
pages no test had ever mounted. Global coverage moved:

| | files | statements | branches |
|---|---|---|---|
| before | 999 | 77.09% (≥77) | 65.08% (≥65) |
| after | **1001** | **76.96%** | **64.86%** |

Two files entered the report, and both entered at low coverage, so the global
percentage fell below its floor. **Adding a test lowered coverage.**

## Why the gate behaves this way

`collectCoverageFrom` in `jest.config.js` declares `src/app-layer/**/*.ts` +
`src/lib/**/*.ts` — 758 files. But the merged report holds **1491**. The extra
~730 are `src/app/**` and `src/components/**` files that Next's transform
instruments whenever a jsdom test imports one; they are never zero-filled,
because they are outside the declared scope.

`scripts/check-merged-coverage.ts` then subtracts the path groups
(`usecases/`, `policies/`, `events/`, `lib/`) from `global`, which removes the
490 well-covered backend files. What remains in `global` is dominated by UI
files whose presence depends on **which components the test suite happens to
import**.

So the `global` denominator is not a declared scope — it is a function of the
suite's import graph. Any PR that writes the first test for a page enrols that
whole file at partial coverage and pushes the ratio down. The gate had 0.09pp
of headroom, so one such PR was enough.

## Verifying without waiting for main

The gate does not run on pull requests (`if: github.event_name == 'push' || …`),
so a PR cannot show this. It can be reproduced exactly:

1. `gh run download <run-id> -n coverage-shards-merged` — the failing run
   uploads the four shard `coverage-final.json` files.
2. Rewrite the `/home/runner/work/...` keys to the local repo path. Without
   this the script's `./src/lib/` group patterns match **0 files**, nothing is
   subtracted from `global`, and it reports a passing 83.27% — a false green
   that looks authoritative.
3. `npx tsx scripts/check-merged-coverage.ts <dir> jest.thresholds.json 4`.

Splicing a locally-measured entry for one file into that artifact predicts the
next run. It is exact for a page only rendered tests load, which is the case
for every file under `src/app/t/**`.

The same harness answers "what would fix it" before writing a line: dropping
the two files reproduced the old 77.10/65.07 (confirming the diagnosis), and
marking them fully covered gave 77.24/65.26 (the ceiling available from them).

## What was done

`tests/rendered/risk-loss-events-page.test.tsx` and
`risk-scenarios-page.test.tsx` — 24 tests covering what those pages actually
do: the honest-empty rollup, the prediction line, the calibration back-test
(including annualisation over the observed loss window and the exclusion of
mean-only forecast rows), the override builder's dedupe-on-(risk, field), the
baseline-vs-scenario table, and the dropped-correlation warning.

| file | statements | branches |
|---|---|---|
| `loss-events/page.tsx` | 59/95 → **92/95** | 29/108 → **72/108** |
| `scenarios/page.tsx` | 48/101 → **89/101** | 11/90 → **54/90** |

Predicted global: **77.19% / 65.21%** — above both floors, and above the
77.09/65.08 that preceded the whole episode.

## Decisions

- **Repay the enrolment, don't unwind it.** Deleting the mounts would have
  restored 999 files instantly, but the loss-events canWrite-vs-canAdmin
  assertion is the most valuable thing in that PR. A file that runs in
  production with nothing checking it is the actual problem; the gate was
  reporting it accurately.
- **Do not touch `jest.thresholds.json`.** The config's own comment is
  explicit: floors are the current floor, never lowered to make CI green. The
  deficit was 0.04pp — exactly the size where lowering is most tempting and
  least defensible.
- **The gate's shape is left alone.** Restricting the report to
  `collectCoverageFrom` would drop ~730 UI files out of `global` and change
  what the floor measures entirely; the numbers would need re-deriving from
  the coverage policy, not adjusting. Worth doing deliberately, not as a side
  effect of an unrelated PR. Until then, expect this to recur for the next
  page that gets its first test, and use the reproduction above to size it in
  advance.
