# 2026-08-25 — Coverage folded into the Test shards (and made PR-reachable)

**Commit:** `ci(coverage): fold the Coverage matrix into the Test shards and gate on PRs`

## Design

Before, `ci.yml` ran the Jest suite **twice**:

```
Test (shard N/4)       JEST_SKIP_RATCHETS=1   --no-coverage    8, 8, 9, 9  min
Ratchets               guards+guardrails+contracts, no DB
Coverage (shard N/4)   whole suite            --coverage      12,10,11,12  min   push/schedule/dispatch ONLY
Coverage (>=60%)       merge 4 artifacts, enforce floors                          push/schedule/dispatch ONLY
```

The second pass existed only to add instrumentation to work the first pass had
already done — ~45 job-minutes — and because that cost was unaffordable per PR,
both coverage jobs were `push`/`schedule`/`dispatch`-only. The consequence was
not "coverage is measured late": it was that **a coverage regression could only
ever be reported after the bad commit was on `main`**, on a check the PR author
never saw. Both jobs were registered as the flagship open instance of that class
in `tests/guardrails/ci-checks-unreachable-before-merge.json`.

After, the suite runs **once**, instrumented, in the jobs that already run it:

```
Test (shard N/4)   JEST_SKIP_RATCHETS=1  --coverage  -> coverage-shard-1..4
Ratchets           the exact complement  --coverage  -> coverage-shard-ratchets
Coverage (>=60%)   needs: [test, ratchets], if: !cancelled(), merges FIVE
```

## The constraint that decided the design: the population

`jest.thresholds.json` has five keys and a path key **removes** its files from
`global`. `global` is therefore a residue, not a universe — so the gate's
verdict is a function of *which tests ran*, and changing that changes what every
floor means with **no number in the diff to review**.

The old Coverage matrix ran one command over the unfiltered suite, so its
population was trivially "everything". The naive fold — just add `--coverage` to
the Test shards — is **not** equivalent, because those shards run with
`JEST_SKIP_RATCHETS=1`. Measured on 2026-08-25:

| set | test files |
| --- | --- |
| `jest --listTests` (unfiltered) | 2040 |
| `JEST_SKIP_RATCHETS=1 jest --listTests` | 1386 |
| the Ratchets job's own path list | 654 |

1386 + 654 = 2040, and `comm -12` on the two sorted lists is **empty** — the
partition is exact.

The ratchet half is not decoration in the report, and this was measured rather
than assumed. Merging real artifacts through `check-merged-coverage.ts` — one
instrumented Test shard alone, then the same shard plus the instrumented
Ratchets run:

| group | shard 1 only | shard 1 + ratchets | delta |
| --- | --- | --- | --- |
| `global` statements | 37.08% | 44.58% | **+7.50pp** |
| `./src/app-layer/usecases/` statements | 31.58% | 38.16% | **+6.58pp** |
| `./src/lib/` statements | 49.61% | 56.91% | **+7.30pp** |
| `./src/app-layer/policies/` statements | 55.91% | 55.91% | 0.00pp |
| `./src/app-layer/events/` statements | 62.44% | 62.44% | 0.00pp |

Against floors of 85 / 87 / 88 those first three columns are not a rounding
question. The true delta over all four shards is smaller — more of the ratchets'
coverage is redundant once the other three shards are in — but it is provably
not zero, and quantifying it exactly would need the full before/after run the
whole change is meant to avoid paying for. The two zero rows are the useful
control: they show the delta is real coverage, not an artifact of the merge.

So the Ratchets job collects and uploads coverage too, and the gate expects
**five** artifacts rather than four. Nothing about the merge or the floors
changed; only the number of files feeding it, which is held equal.

## Files

| File | Role |
| --- | --- |
| `.github/workflows/ci.yml` | `coverage` matrix deleted; `test` + `ratchets` instrumented and uploading; `coverage-gate` now `needs: [test, ratchets]`, `if: !cancelled()`, expects 5 artifacts |
| `tests/guardrails/coverage-gate-population.test.ts` | New. Holds the invariant: every Jest job collects + uploads coverage, the expected-artifact count matches what CI produces, the gate needs every producer and is PR-reachable, and every path `JEST_SKIP_RATCHETS` drops is claimed by another instrumented job |
| `tests/guardrails/ci-checks-unreachable-before-merge.json` | `ci.yml:coverage` removed (job gone); `ci.yml:coverage-gate` re-triaged `never` -> `conditional` (it is `!cancelled()`, which the evaluator cannot resolve) with a corrected reason |
| `tests/guards/ci-flake-hardening.test.ts` | Timeout floor follows the work: the `Coverage (shard N/4)` entry becomes `Test (shard N/4)` 20 + `Ratchets` 10 |
| `docs/coverage-policy.md`, `CLAUDE.md` | The "does not run on pull requests" claim was authoritative and is now false — rewritten, with the population rule stated where the floors are documented |

## Measured cost

One Test shard (shard 1/4, `JEST_SKIP_RATCHETS=1`, `--maxWorkers=2`, local
8-core box with the DB on 5434):

| run | wall clock | suites |
| --- | --- | --- |
| `--no-coverage` | 1591 s | 343 passed, 4 failed to run (environment — see below) |
| `--coverage --coverageReporters=json` | **1808 s** | 346 passed, 1 failed to run |

**+217 s, +13.6%.** The Ratchets job measured separately: 114.5 s -> 174.4 s
(+52%), the higher ratio being what you would expect from fast source-scanning
tests where instrumenting the modules they import dominates.

The four failures in the uninstrumented run were environmental and three did not
recur: a jsdom worker OOM under parallel load, and two integration suites that
lost their per-worker database while other Jest invocations were running against
the same shared Postgres. The one that reproduces in both runs is
`tests/rendered/dashboard-grid-and-picker.test.tsx`, and it is a **git-worktree
artifact**: `moduleNameMapper` resolves `react-grid-layout/legacy` to
`<rootDir>/node_modules/react-grid-layout/dist/legacy.js`, and a worktree's
`node_modules` is an empty directory. Zero tests failed in either run
(7223 and 7258 assertions passed).

## Decisions

- **Five artifacts, not four.** The alternative — leave the Ratchets job
  uninstrumented and accept a smaller population — would have been a silent
  change to the meaning of every floor. Proving it harmless needs a full
  before/after merged run (~2 h of the shared box). Preserving the population
  needs a six-line YAML addition. The cheap correct option wins over the
  expensive maybe-equivalent one.
- **The runtime check is not enough on its own.** `check-merged-coverage.ts`
  refuses when the artifact COUNT is wrong, so a dropped upload is caught. It
  cannot catch a job that stops emitting coverage *while somebody edits the
  expected count to match* — which is exactly what a plausible "the ratchets job
  doesn't need coverage" cleanup looks like. That is the hole the new guardrail
  closes, which is why its assertions are cross-file rather than a count check.
- **The guard verifies the mechanism, not the partition, on purpose.**
  Re-deriving the split with three `jest --listTests` boots inside a guard suite
  is slow and fragile. Instead it parses the `JEST_SKIP_RATCHETS` branch out of
  `jest.config.js` and requires every path that branch excludes to appear as a
  positional argument to another instrumented job. Adding `tests/foo/` to the
  skip list without adding it to the Ratchets job means those tests run
  *nowhere* — this fails in the same diff.
- **`if: !cancelled()` and nothing else.** The gate keeps reporting when a
  producing job fails (a skipped required check reads as "not failing"), and
  carries no `github.event_name` condition at all, which is what makes it
  PR-reachable. The reachability evaluator cannot resolve `cancelled()`, so it
  classifies as `conditional` and still needs a registry entry — same shape as
  `test-summary`.
- **Uploads keep their default `if: success()`.** A failed shard uploads
  nothing, the count check refuses, and the gate goes red rather than reporting
  a number computed from a partial suite. Refusing to gate on partial data is
  the behaviour the script already documents.
- **The `Coverage (shard N/4)` check contexts disappear.** They were never
  required in branch protection — a required check that never runs on a PR would
  block every merge — so no branch-protection edit is needed. `Coverage (>=60%)`
  keeps its name and now actually reports on PRs.
