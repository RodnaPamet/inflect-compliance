# 2026-10-30 — The Test shards' heap: a trail before the crash, and the compilation cache (#4613)

**Commits:** `6c95434c9 test(ci): the heap reporter leaves a trail before an exit 134, not after it (#4613)`,
`682825432 fix(ci): run the Test shards without V8's compilation cache (#4613)`

## Design

Two problems, one cause.

- **Shard 7/7 died intermittently** with `Ineffective mark-compacts near heap
  limit` (exit 134) in the merge queue, on the same 351 files that pass at ~2 GB
  in other runs. On main it ran away to 9-10.5 GB in about one push run in seven
  since the shard was introduced on 2026-10-25 (26 of 184 runs), at a steady
  rate, so no single commit introduced it.
- **Shard 2/7 ended every main run near 8.5 GB of heapUsed**, four times every
  other shard's median.

**The trail.** The heap summary (#3977) is printed by `onRunComplete`, which an
exit 134 never reaches. `onTestResult` now writes one line to stderr the first
time `heapUsed` reaches 4 GB and each 2 GB above it, naming the file, its index,
the files since the previous mark and the process uptime, so the next exit 134
arrives with the file range in which the heap grew. It is quiet at the usual
~2 GB. On diagnostic run 41089355501 a shard 7/7 runaway printed marks at files
142, 198, 259 and 331.

**What grew.** A second diagnostic reporter counted V8's live contexts
(`v8.getHeapStatistics().number_of_native_contexts`) every 25 files, without
forcing a collection, and at the end forced ten full collections in a row:

```
                         file 100   200   300   350    after 10 forced gc()
shard 2/7 (second run)         24   117   202   240    8120 MB, 238 contexts
shard 7/7, runaway run         34   125   205  (collapsed to 20 at ~10.2 GB)
shard 7/7, normal run          18    21    21    24    957 MB, 6 contexts
```

Each in-band test file runs in its own vm context. In shard 2/7, and in a shard
7/7 runaway, from about file 75 almost every finished file's context stays
alive, ~30 MB each, and the ten forced collections free none of them: the heap
is live, not garbage waiting for a collection. In a normal shard 7/7 run the
count stays flat.

**What held it.** Re-running shard 2/7 with `node --no-compilation-cache` kept
the same 352 files at a 1.5-2.1 GB peak and 1.0-1.1 GB after a forced gc(), in
both repetitions (run 41088386042); shard 7/7 stayed under 2 GB in both. So the
retainer is V8's compilation cache. Which of its tables holds the contexts,
and what starts the accumulation part-way through a run, were not identified.

**The fix** is that flag on the `Test` step. It is a V8 option that
NODE_OPTIONS refuses, so the step runs `node --no-compilation-cache
node_modules/jest/bin/jest.js` instead of `npx jest`.

**With the flag, every shard** (peak heapUsed in MB; main is the median of 15
push runs on 2026-10-30):

```
shard                      1      2      3      4      5      6      7
main, cache on          1902   8523   1597   1813   2053   1802   2147
run 41091345707 (CI)    1781   1524    998   1538   2028   2052   1403
run 41091775053 (diag)  1912   1561   1591   3761   1938   1713   1477
```

The live context count in the diagnostic run stayed between 2 and 26 in every
shard, against ~240 on shard 2/7 with the cache on. Shard 4/7's 3.8 GB there
was pre-GC: it kept 1.1 GB after a forced gc() and held at most 23 contexts.

Shard 2/7's accumulation happened in every run with the cache on (unless gc()
was forced every 25 files) and in none with it off, so that half is settled.
Shard 7/7's runaway came in about one run
in seven; it ran four times with the flag (1386-1809 MB) and never ran away,
which is evidence but not proof — at that rate four clean runs happen about
half the time by chance. If it returns, the trail names the file range.

The cost is time. Against six runs of the same shards from the same hour
without the flag, the `Test` step took about 10% longer (3,717 s across the
seven shards against 3,377 s of medians), and the slowest shard, 3/7, took 758 s and
779 s against 607-751 s.

## Files

| File | Role |
| --- | --- |
| `tests/reporters/heap-summary-reporter.js` | The trail: one stderr line per 2 GB mark from 4 GB, written in `onTestResult`. |
| `tests/unit/heap-summary-reporter.test.ts` | Quiet at ~2 GB; one line per mark; highest mark only on a jump; never repeats. |
| `.github/workflows/ci.yml` | The `Test` step runs Jest's bin under `node --no-compilation-cache`. |
| `tests/guards/in-band-shard-heap-bound.test.ts` | Holds the flag on the command line and out of NODE_OPTIONS. |
| `tests/guardrails/coverage-gate-population.test.ts` | Recognises the `node … jest/bin/jest.js` form, so the shards stay in the coverage census. |
| `CLAUDE.md` | How to read a shard's trail and summary, and why the shards run without the compilation cache. |

## Decisions

- **No eighth shard and no higher ceiling.** The owner's decision on #4613 and
  #4615, and the measurement agrees: a shard that holds every finished file's
  context grows with its file count, so a ceiling or a shard count only moves
  the day it fails.
- **The flag, not a forced gc() every N files.** Forcing a full collection
  every 25 files also kept shard 2/7 at 1.5-1.7 GB (run 41086516606), but it
  needs `--expose-gc`, it works by changing when V8 collects rather than by
  removing what holds the contexts, and ten forced collections at the end of a
  run freed nothing once the contexts were held. The flag removes the
  retainer. The forced collections were also faster on that shard (356-365 s
  against 406-556 s without), so if the flag's ~10% ever matters more than
  knowing why it works, that is the measured alternative.
- **Marks on `heapUsed`, from 4 GB, every 2 GB.** A normal shard 7/7 run peaks
  at 3.5 GB at most (155 main runs), so 4 GB is quiet on a healthy run; the
  death comes near 10 GB under `--max-old-space-size=12288`, so 4/6/8/10 gives
  three or four lines before it. `heapUsed` is pre-GC, so a mark says the heap
  is large, not that it is live; the reporter's header says so.
- **The trail writes immediately, to stderr.** A buffered line, or one printed
  by `onRunComplete`, is lost with the process.
- **Measured on CI, not locally.** Local replays of both shards under the same
  Node version, environment and ceiling never reproduced the accumulation, so
  every number above comes from dispatch-only diagnostic runs on a throwaway
  branch.
- **The rate limiter's module-level interval** was a second, smaller retainer
  found on the way (`TimersList → Timeout → _onTimeout → module scope`). It is
  fixed in its own pull request because it changes a security module's
  behaviour; it lowered shard 7/7's retained heap by roughly 300 MB and did
  not stop the runaway.
