# 2026-10-25 — The rendered suites stop holding a TypeScript language service

**Commit:** `8cde9edae test(rendered): let ts-jest transpile each file instead of holding a language service`

## Design

`tests/rendered/tsconfig.json` is ts-jest's config for the jsdom project. It
overrode the root config's `isolatedModules: true` with `false`. In ts-jest
29.4, that one option decides the compiler:

- **`true`:** each file goes through `ts.transpileModule` on its own. The node
  project and the Next build already work this way.
- **`false`:** ts-jest builds a language service over the config's whole program
  and keeps it for the life of the process (`ts-compiler.js`,
  `_createLanguageService`). Here that program is every rendered suite plus all
  of `src`.

The Test shards run `--runInBand`, so each shard is one process. The first
rendered file in a shard pays for building the service, and every file after it
carries the service in the heap.

This was found from a flake, not from a memory report:

1. **The flake.** `tests/integration/risk-update-round-trip.test.ts` failed the
   merge queue twice, for two docs-only PRs (#4114, #4102). Both failures were
   on shard 2/6, and both were a 5 s tenant transaction that expired.
2. **The full job logs.** Prisma's slow-query listener showed one trivial query
   per failure taking about 5 s:
   - a `Control` select, 4,942 ms;
   - the audit-chain head lookup for a tenant with no rows, 5,328 ms.

   The queries logged around them took 112–289 ms. `@prisma/adapter-pg` times
   queries in JavaScript, so a blocked event loop inflates the duration. That
   points at the process stalling, not at the database.
3. **A local run of shard 2/6 with `--trace-gc --logHeapUsage`.** The run
   matched CI's flags: in-band, coverage on, 12 GB heap. The heap kept after a
   full GC went from about 1 GB to about 4.9 GB on the shard's fifth file,
   `tests/rendered/agent-policy-card-tab.test.tsx`. That is the shard's first
   rendered file, and it took 79 s. The heap never came back down.

Every full GC after that point walks roughly 5 GB of live objects. On CI's
runners those pauses are long enough to stall a transaction past its timeout.
The same headroom ran out when shard 2 hit out-of-memory on #3982.

Measured on the same local shard (365 files, the same 8,985 tests passing):

| | `isolatedModules: false` | `true` |
|---|---|---|
| Wall time | 1,241 s | 551 s |
| Heap after full GC, median / max | 5,456 / 6,250 MB | 1,024 / 1,831 MB |
| Longest full-GC pause | 1,316 ms | 465 ms |
| Total full-GC pause | 23.1 s | 11.1 s |

## Files

| File | Role |
|---|---|
| `tests/rendered/tsconfig.json` | `isolatedModules` goes from `false` to `true`, with a comment saying why. |

## Decisions

- **This fixes the cause, not the timeout.** Raising `TENANT_TX_TIMEOUT_MS`, or
  giving the test a longer budget, would have hidden a process-wide stall that
  any transactional test on that shard could hit. The flake was only where it
  showed first.
- **Type-checking the rendered suites is unaffected.** ts-jest's own diagnostics
  were the only thing the language service bought, and
  `npm run typecheck:rendered` checks the same program. Its config extends this
  file, so it now applies `isolatedModules` checks to the suites too. It passes
  with 0 errors, and the root config already holds `src` to those checks.
- **Emit and coverage were checked, not assumed.** All 422 rendered suites pass
  (4,146 tests). On a six-suite sample, the coverage statement, branch and
  function maps of all 1,263 instrumented files are identical under both
  settings, so no coverage floor moves.
- **The setting stays in this file, not in the jest transform options.** Passing
  `isolatedModules` to ts-jest directly is deprecated and logs a warning on
  every run. Putting it in the tsconfig is the way ts-jest documents.
