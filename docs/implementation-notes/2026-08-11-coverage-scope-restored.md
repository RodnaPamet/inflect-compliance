# 2026-08-11 — The coverage gate measures the declared scope again

**Commit:** `<sha>` fix(coverage): the gate measures the declared scope again

Successor to `2026-08-11-coverage-gate-enrolment.md`, which diagnosed the
symptom — adding the first test for a page turned `main` red — and
deliberately left the cause alone: *"Restricting the report to
`collectCoverageFrom` would drop ~730 UI files out of `global` and change
what the floor measures entirely; the numbers would need re-deriving from
the coverage policy, not adjusting. Worth doing deliberately, not as a
side effect of an unrelated PR."* This is that deliberate change.

## The mechanism

Jest's `groupOptions` (`jest-config/build/index.js`) splits normalised
options into a **globalConfig** bucket and a **projectConfig** bucket.
`readConfigs` builds `globalConfig` only from the ROOT config parse and
discards each project's own — inline project objects do not inherit
top-level keys, and a key written to the wrong bucket is silently
ignored rather than rejected.

Measured on the installed Jest (30.4.2, not the 29.7.0 the config
comments claimed) with `npx jest --showConfig`:

| key | read from | was declared on | effect |
|---|---|---|---|
| `collectCoverageFrom` | globalConfig | both project blocks | inert — resolved `[]` |
| `coverageThreshold` | globalConfig | node project | inert (deliberate — see below) |
| `coveragePathIgnorePatterns` | projectConfig | top level | inert — both projects fell back to `['/node_modules/']` |

An empty `collectCoverageFrom` disables two separate things:

- **The instrumentation filter.** `jest-runner` passes
  `globalConfig.collectCoverageFrom` into `shouldInstrument`, which at
  `@jest/transform` skips a file only `if (options.collectCoverageFrom.length > 0)`.
  Empty means *no filter*: every non-test module any suite loads gets
  instrumented, including `src/components/**` and `src/app/**`.
- **The zero-fill.** `@jest/reporters::_addUntestedFiles` is guarded by
  the same `length > 0`. Empty means a declared file that no test
  imports is **absent** from the report rather than counted at 0%.

So the gate's denominator was not a declared scope — it was the suite's
import graph. Nothing in `@jest/*` or `jest-*` reads
`projectConfig.collectCoverageFrom`; the two project copies were written
and never read.

## What that did to the gate

`scripts/check-merged-coverage.ts` buckets the merged report by
resolved-path prefix, and a path key REMOVES its files from `global`. So
`global` was "the merged report minus the four path groups" — a bucket
whose composition depended on which components a test happened to
import. Writing the first test for a page enrolled that whole file at
partial coverage and pushed the ratio DOWN. With 0.09pp of headroom, one
such PR was enough to take `main` red on 2026-08-11.

## This is a revert

`git log -S` puts the removal at `29d429a73` (#48, GAP-15), whose own
note says it: *"Also moved `collectCoverageFrom` out of the top-level
config."* GAP-15 correctly diagnosed that a top-level `coverageThreshold`
was not enforced under `projects:`, moved the threshold into a project
block — and moved the scope with it, which broke the half that had been
working. `docs/coverage-policy.md` has described the scoped, zero-filled
denominator ever since Wave B; every wave's floor was derived believing
it. The doc was right and the config was wrong for three and a half
months.

## Files

| file | role |
|---|---|
| `jest.config.js` | `collectCoverageFrom` to the top level; `coveragePathIgnorePatterns` onto both projects; the three comment blocks that stated the opposite rewritten |
| `jest.thresholds.json` | floors re-derived against the corrected population |
| `tests/guards/coverage-config-resolution.test.ts` | **new** — resolves the real config and pins all three placements |
| `tests/guards/coverage-ratchet.test.ts` | `RATCHET_FLOOR` hardened to the pre-change enforced level |
| `scripts/check-merged-coverage.ts` | a declared group matching zero files is now a hard failure |
| `tests/unit/scripts/check-merged-coverage.test.ts` | pins that, and re-points fixtures at the population that now exists |
| `docs/coverage-policy.md` | rewritten onto the corrected semantics |
| `docs/testing.md`, `CLAUDE.md` | stale coverage tables replaced by pointers |

## Decisions

- **The guard asserts the RESOLVED config, not the source text.** The
  whole bug is that the key was present and in the wrong bucket — a
  regex over `jest.config.js` would have passed throughout. This is the
  same regression class GAP-15 introduced and nothing caught for three
  months, in either direction.
- **`coverageThreshold` stays inert on purpose.** Moving it to the
  global config would make Jest enforce per-shard, comparing a quarter
  of the data against floors calibrated on all of it. The floors are
  checked once on the merged total; the config copy is documentation.
  The guard pins that it resolves to `undefined` so the intent is
  explicit rather than accidental.
- **The zero-file group is a hard failure now.** A declared group
  matching nothing used to print `ok … 0 files {}` — `blankSummary()`
  gives `total: 0`, `percentFor` returns null, `evaluate` continues, and
  the gate goes green measuring nothing. It had already fired: the
  local-reproduction recipe in the predecessor note produced "a passing
  83.27%" from artifacts whose paths matched no group.
