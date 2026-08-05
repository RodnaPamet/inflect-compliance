# 2026-08-05 — CI: remove duplicated work

**Commit:** `<pending> perf(ci): stop paying for the same work four times`

Seven changes to the CI pipeline. **None of them changes what is tested.**
Every one removes work the pipeline was doing more than once, or work it was
doing in a shape that made it slower than it needed to be. Where a premise
behind a change turned out to be wrong when measured, the measurement is
recorded here and the change was scoped down rather than made anyway.

## Baseline

Step durations from run `30939670414` on `main`, which is what every "before"
number below refers to:

| Job | Step | Before |
| --- | --- | --- |
| Build | Build Next.js (production) | 236s |
| E2E | Build Next.js app | 195s |
| Load Smoke | Build Next.js app | 197s |
| Test (shard 1/4) | unit + integration | 463s |
| Test (shard 1/4) | architectural guards | 66s |
| every job | Setup Node + Prisma client | 49-63s |
| Coverage | whole job | ~35 min (cancelled at 35m15s on 2026-08-03) |

## Result

Measured end-to-end: `main` run `30939670414` vs verification run
`30974778739` (same branch, all seven changes in, dispatched so the
push-only jobs actually execute).

| Job | main | now | |
| --- | --- | --- | --- |
| Coverage | **1967s** one job | 561-656s × 4 + **59s** gate | sharded |
| Test (shard 1-4) | 608 / 533 / 571 / 505s | 470 / 447 / 503 / 493s | ratchets removed |
| Ratchets | ran 8× inside the shards | **121s**, once | new job |
| Load Smoke | 338s | **157s** | build → artifact download (197s → 4s) |
| Build | 309s | **210s** | `.next/cache` |
| E2E | 1062s | 996s | one Playwright invocation |

- **Critical path (longest job): 1967s → 996s.** Coverage is no longer the
  bottleneck; E2E is.
- **Total runner seconds: 6593s → 6525s (−1%).** Essentially flat — the
  coverage shards' extra fixed cost is paid for by the work removed
  elsewhere.

`docker` (153s → 706s) and `trivy` (449s → 554s) are excluded from that
total. Both jobs are byte-identical to `main` in this PR; `docker` caches
via `cache-from: type=gha`, which is ref-scoped, so a `workflow_dispatch` on
a feature branch gets a cold layer cache and Trivy then scans the uncached
image. Branch artefact, not a regression.

### Why four coverage shards

Fitting the observed numbers — unsharded 1967s, four shards averaging 597s —
gives a per-shard fixed cost of **141s** (container init, npm ci, migrations,
Jest boot) against **1826s** of divisible work:

| shards | wall | runner | % of the 25-min budget |
| --- | --- | --- | --- |
| 1 | 1967s | 1967s | 131% ← the cancellation |
| 2 | 1054s | 2108s | 70% |
| 3 | 749s | 2248s | 50% |
| **4** | **597s** | **2389s** | **40%** |

Four costs +422s of runner time (+21% on this job) for a 3.3× wall-clock
improvement, and lands at 40% of budget against a job whose history is three
timeout raises and one `main`-red cancellation at ~1 min of growth per run.

## Design

### 1. The ratchet suite ran twice, on four runners

`tests/guards/` + `tests/contracts/` were executed by their own steps inside
each of the four `test` shards, AND swept up again by the sharded
`npx jest` in the same job — Jest's `--shard` partitions all matched files,
and nothing excluded them. So 776 ratchet suites ran 8 times per push (4
shards × 2 paths).

They are now excluded from the shards behind `JEST_SKIP_RATCHETS=1` (a
`testPathIgnorePatterns` branch in `jest.config.js`) and run **once**, in a
new `ratchets` job. That job needs no Postgres and no migrations, because
only one ratchet in the whole set does: `rls-coverage.test.ts` reads the live
database. It stays in the shards, and the exclusion pattern is a negative
lookahead that spares it.

Verified locally: the new job's exact command runs **776 suites / 10,586
tests green in 97s**, and `JEST_SKIP_RATCHETS=1` takes the shard file count
from 1946 to 1170 with `rls-coverage` still present.

### 2. `next build` ran four times per push

Four jobs compiled the same SHA. They are not all the same artifact, which
is the part the change had to get right:

| Job | Build-time env | Same bundle? |
| --- | --- | --- |
| `build` | `NODE_ENV=production` | — (the reference) |
| `load-smoke` | `NODE_ENV=production` | **yes** |
| `e2e` | `+ NEXT_TEST_MODE`, `NEXT_PUBLIC_TEST_MODE` | **no** |
| `docker` | builds inside the image | no (it is the shipped artifact) |

So `build` now uploads `.next` and `load-smoke` downloads it — one build
removed, ~197s. `e2e` keeps its own build and the workflow says why: its
bundle **inlines** `NEXT_PUBLIC_TEST_MODE` at compile time, and that flag is
what suppresses the Driver.js onboarding tour and the calendar-badge polling
so Playwright's `networkidle` can settle. Handing e2e the plain production
artifact would not fail loudly — it would quietly re-enable both and read as
flake.

`load-smoke` keeps a guarded fallback build (`if [ -f .next/BUILD_ID ]`) so
re-running that job alone, or running it after the artifact expires, still
works instead of failing on a missing directory.

### 3. No build cache — but node_modules is deliberately still uncached

`.next/cache` (the webpack/SWC incremental cache) is now cached for `build`
and, under a separate key, for `e2e` — which writes to `.next-test/` because
`NEXT_TEST_MODE` routes `distDir` there (`next.config.js:157`). Only
`cache/` is restored; restoring the rest of `.next` would risk publishing a
stale `BUILD_ID` as this SHA's artifact. It is also excluded from the
uploaded artifact, which `next start` never reads.

`node_modules` is **not** cached, against the original premise. Measured on
this repo: **1.9 GB across 129,188 files**. Restoring and extracting that
does not beat the `npm ci` it would replace, because `actions/setup-node`'s
`cache: npm` already removes the genuinely slow part (the registry fetch).
The trade would have been roughly zero seconds for a stale-tree failure mode.

### 4. Migrations ran 6-10 times per run

Two setup paths re-did work the CI job had already done one step earlier:
`tests/setup/globalSetup.ts` ran `prisma migrate deploy`, and
`tests/e2e/global-setup.ts` re-seeded — both after the workflow's own
migrate/seed steps. Both are now skipped when `CI` is set, and unchanged
locally, where they are the only thing that sets the database up.

The two Playwright invocations (`a11y` gate, then the full suite) were also
one `npx playwright test` each with overlapping selection; they are now a
single invocation with the a11y specs split into their own **project**.

### 5. `--runInBand` — tried, measured, kept

The observation is true: `tests/setup/globalSetup.ts` only clones the
per-worker template databases when `maxWorkers > 1`, so every `--runInBand`
invocation left that machinery switched off. It is not a defect. The cloning
exists to make **parallel** execution safe; serial execution against one
database is already safe, so there is nothing for it to protect.

Switching it on was tried and measured — hosted 2-core `ubuntu-latest` with
Postgres in a service container (dispatch run `30973579267` vs `main` run
`30939670414`). Total Jest work across the four shards:

| | total shard work | files |
| --- | --- | --- |
| `--runInBand` (main) | **1876s** | 1946, ratchets included |
| `--maxWorkers=1` / `=2` | **4311s** | 1170, ratchets excluded |

2.3× worse on **fewer** files. Per shard at the same ~293 files: 2 workers
810s, 1 worker 1146s, against 463-477s for `--runInBand` on `main` while
that run was *also* carrying the ratchets.

Worker mode loses twice over on this runner shape: forking buys no
parallelism on 2 cores, and 2 workers adds template-clone cost plus
contention with the Postgres container on the same box. Reverted; the
workflow comment records the numbers so the question is not re-opened on
the same reasoning. If the runners ever get more cores, re-measure — the
conclusion is about the runner, not about Jest.

### 6. Coverage: sharded, and one premise dropped

The coverage job was a single unsharded `--runInBand` pass over all 1946
test files. It had been cancelled at its ceiling on `main` and the timeout
had been raised three times; the previous comment's own advice was to shard
it rather than raise the number a fourth time.

It is now a **4-way matrix that measures** plus a **`coverage-gate` job that
merges and enforces**. Thresholds cannot be checked per shard — each shard
sees a quarter of the execution and would report most of `src/` uncovered
against floors calibrated on all of it.

`scripts/check-merged-coverage.ts` does what Jest's `--coverageThreshold`
did. The rule that makes it non-trivial: a non-`global` key does not just
add a check, it **removes** those files from `global`. `./src/lib/` at 89%
and `global` at 78% means "everything *outside* the four listed paths must
beat 78". Implemented as a naive overlay, `global` silently gets easier — the
gate keeps passing while covering less, and nothing about the output looks
wrong. `tests/unit/scripts/check-merged-coverage.test.ts` pins that rule.

The script implements path-prefix keys and positive percentages only — the
subset `jest.thresholds.json` uses — and **throws** on a glob or a negative
threshold rather than skipping it.

Verified end-to-end before wiring: the same selection run unsharded, and run
as 3 shards then merged, produce **byte-identical** coverage —
`statements=2190/6878, branches=832/5080, functions=219/1237,
lines=2115/6287` both ways, over the same 116 files. All four CLI exit paths
(fail on floors, pass, wrong shard count, missing directory) were exercised.

**The "exclude ratchets from instrumentation" half of this item was dropped,
on measurement.** The ratchets are 97 seconds of a ~35-minute job — 5% — and
they instrument 281 files under `src/`, so excluding them would move the
measured number for a saving that is not where the time is. The 35 minutes
is test execution, which is what sharding addresses.

**Verified on real CI data** (dispatch run `30973579267`). The gate merged
four shard files into 1453 files and every group landed just above a floor
calibrated against the unsharded run:

```
Merged 4 shard coverage files — 1453 files.
ok   global                     969 files  statements 77.86% (>=77)  branches 65.77% (>=65)  lines 80.41% (>=78)
ok   ./src/app-layer/usecases/  170 files  statements 90.09% (>=87)  branches 79.24% (>=79)  lines 91.60% (>=88)
ok   ./src/app-layer/policies/   16 files  statements 92.85% (>=92)  branches 87.50% (>=86)  lines 93.70% (>=93)
ok   ./src/app-layer/events/      6 files  statements 88.26% (>=77)  branches 76.34% (>=75)  lines 89.65% (>=78)
ok   ./src/lib/                 292 files  statements 90.54% (>=88)  branches 79.12% (>=78)  lines 92.10% (>=89)
```

The margins are the evidence. A merge that lost data would fall under floors
this tight; one that double-counted or mis-grouped would inflate `global`.
And 969 + 170 + 16 + 6 + 292 = 1453 — every file in exactly one group, which
is the removal rule holding on real data.

Worth flagging separately, because it is pre-existing and not caused here:
`usecases` branches passes at **79.24% against a 79% floor**. A 0.24-point
margin is thin enough that an unrelated PR can trip it.

The gate job keeps the name `Coverage (≥60%)` so the required-check name in
branch protection is unchanged. Making it run on pull requests is now
affordable but is **not** part of this change: it needs a branch-protection
edit, because one check became five.

### 7. Playwright video, and a false comment

`video: 'on'` recorded and uploaded a video for every passing test. Now
`retain-on-failure`, matching what `trace` and `screenshot` already did.

The `e2e` job carried a comment claiming the suite runs `workers: 1,
fullyParallel: false` because "specs share seeded-tenant state". Both halves
had been false since the e2e isolation work landed — `playwright.config.ts`
says `fullyParallel: true, workers: 2`, and mutating specs take an isolated
tenant per test. Corrected, with a note saying what it used to claim.

## Files

| File | Role |
| --- | --- |
| `.github/workflows/ci.yml` | all seven pipeline changes |
| `jest.config.js` | `JEST_SKIP_RATCHETS` branch in `testPathIgnorePatterns` |
| `playwright.config.ts` | `retain-on-failure`; a11y split into its own project |
| `tests/setup/globalSetup.ts` | skip migrate under `CI` |
| `tests/e2e/global-setup.ts` | skip seed under `CI` |
| `scripts/check-merged-coverage.ts` | merge shard coverage, enforce the floors |
| `tests/unit/scripts/check-merged-coverage.test.ts` | pins the group-removal rule |
| `tests/guards/ci-flake-hardening.test.ts` | timeout floor follows the work, not the label |

## Decisions

- **The e2e build is not shared, and the reason is written in the workflow.**
  It is the one place where "these four builds are the same" is wrong, and
  the failure it would cause is silent flake rather than a red step.
- **`node_modules` caching was measured and rejected**, not skipped. The
  number (1.9 GB / 129k files) is recorded so the question does not get
  re-opened on intuition.
- **The coverage gate's semantics are reimplemented, so they are tested.**
  Replacing a Jest feature with a script is only safe if the script's edge
  case — group removal from `global` — is pinned by a test that fails when
  it regresses. The equivalence check against an unsharded run is the other
  half of that argument.
- **The threshold script refuses what it does not implement.** A future glob
  key fails loudly instead of being silently ignored, which is the failure
  mode that would otherwise leave a group ungated.
- **The shard-count argument is load-bearing.** A missing shard artifact
  would read as uncovered code; the gate refuses to report a number rather
  than gate on partial data.
- **`ratchets` runs without Postgres.** Of 777 ratchet files exactly one
  needs a database, so provisioning one for the whole set was paying for the
  common case at the cost of the rare one.
- **P2.5 was implemented, measured, and reverted.** The premise was true —
  `--runInBand` does leave the per-worker DB cloning off — but the cloning
  protects parallel execution, and serial execution needs no protection.
  Switching it on cost 2.3× total shard time on a 2-core runner. Keeping a
  change because it was asked for, after the measurement says it costs
  2.3×, would be the wrong trade; the numbers are in the workflow comment
  so the case does not get re-argued from the same premise.
- **The timeout floor moved with the work.** `ci-flake-hardening.test.ts`
  keyed its 50-minute floor to a job *name*; that name now belongs to a merge
  step. The floor was re-keyed to the shard job rather than deleted, and the
  entry says what to restore if the sharding is ever reverted.
