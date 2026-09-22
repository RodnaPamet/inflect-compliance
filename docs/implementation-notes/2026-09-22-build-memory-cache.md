# 2026-09-22 — The Next.js build cache was costing 7.2 GB and making the build slower

**Commit:** `<sha>` fix(ci): drop the accumulating Next build cache, and gate the peak

Closes the regression tracked in #2753: `Build` was peaking at ~15.8 GB on a
~16 GB runner, dying to the kernel OOM-killer, and evicting green PRs from the
merge queue.

## The measurement

One variable moved — the `Build` job's `actions/cache` restore of `.next/cache`
— on `main`'s code at `288d7ff3e` (#2754, a draft opened to produce this
number and nothing else):

| | peak `used` | peak `next-build` | min available | Build | duration |
|---|---|---|---|---|---|
| cache restored | 15788 MB | 14443 MB | 201 MB | **failed** | killed at ~3m40s |
| cache disabled | 9263 MB | **7204 MB** | 6726 MB | **success** | **286 s** |

**−7239 MB.** Headroom goes from 201 MB to 6.7 GB.

And it was never buying speed either:

| | duration |
|---|---|
| cold (no cache) | 286 s |
| warm, on `main` | 375 / 387 / 408 / 410 / 523 s |

Reconciling the cache cost more than compiling without it, on every warm run
measured. Cost on both axes.

## Why a cache made it worse

The key was

    ${{ runner.os }}-next-prod-${{ hashFiles('package-lock.json') }}-${{ hashFiles('src/**') }}

with `restore-keys` falling back to the lockfile prefix and then to a bare
`Linux-next-prod-`.

`hashFiles('src/**')` changes on every commit, so **the exact key never hit**.
Every build fell back — and the final fallback matches *any* cache, including
one built against a different `package-lock.json`. PR #2744's build asked for
lockfile hash `98c7b9b5…` and restored one built under `61d8890c…`: a webpack
cache from different `node_modules`.

So each build deserialised an accumulated pack and reconciled it against
sources it was not built from, then wrote a slightly larger one for the next
build to inherit. That is why the peak climbed **monotonically with merge
count**: across the 21 merges measured, `src/` grew **0.55%** while peak memory
grew **43%**.

`e2e-bundle` carried the identical shape for `.next-test/cache` and the
identical symptom — 15241 MB and 14761 MB on recent runs. Both are removed.

## Why this recurred at all, and what stops it next time

#2699 took the peak from 15815 MB to 8505 MB on 2026-09-21 by turning off
prerender source maps. Twenty hours later it was 15788 MB again. That option is
still set and still effective — verified: present at `next.config.js:82`,
consumed at `next/dist/build/index.js:409`, top-level in the config schema.
Nothing regressed. The win was simply eaten by something else while **nobody
was looking**, because #2698 was closed on the strength of a one-off
measurement.

The sampler has streamed `[mem]` and `[rss]` lines into every build log since
#2526 and **nothing read them**. `Report peak memory` printed the peak and
exited 0 at any value.

It is now a gate: peak above `MEM_CEILING_MB` (12288) fails the job. On a
~16000 MB runner that fires ~3.7 GB before the kernel does, which matters
because the kernel kill takes the runner with it and leaves
`The operation was canceled` and nothing to diagnose.

### A missing measurement is not a pass

The step used to `exit 0` whenever the sample log was empty, scoring a broken
sampler exactly like a lean build. It now distinguishes the two using the build
step's `outcome`: no samples after a **successful** build means the instrument
is broken and the ceiling is unenforced, and that fails. No samples after a
failed build is expected and passes.

Six cases are proved by construction rather than asserted — under ceiling
passes, over fails, exactly at the ceiling passes, one MB over fails, and both
no-sample arms behave as described.

## What was NOT the cause

Each of these was measured and cleared, and is recorded so nobody re-runs them:

- **The heap cap.** `--max-old-space-size` bounds old space, not RSS. The
  failure is a kernel `Killed`, never `JavaScript heap out of memory`, and
  `[rss]` shows a single `next-build` process. Re-tuning it is refuted work.
- **Code growth.** `src/` +0.55% against +43% peak.
- **`enablePrerenderSourceMaps`.** Present, consumed, effective.
- **Next itself.** 16.3.5 across the whole climb; lockfile byte-identical.

## A trap for the next reader

Four local reproductions — cold, exact-match warm, stale cache, and CI's
verbatim `NODE_OPTIONS` + `npx` invocation — all peaked between 6485 and
7846 MB, which looked like solid evidence that the cache was innocent.

It was not. The local cache was **one build old**; CI's was dozens of
generations deep. A one-generation cache costs nothing and a many-generation
one costs 7.2 GB, so the fixture, not the hypothesis, was wrong. The tell was
visible in hindsight: cold-on-CI (7204 MB) lands inside that local range, so
the local runs had been faithful the whole time and only the cache's *age*
differed.

If a cache is ever reintroduced here, reproduce with an **aged** one or the
measurement will say what this one said.
