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

## The second defect, which only the measurement found

Turning the zero-fill back on made the numbers WORSE, not better, and the
reason is not coverage:

| group | before | after (raw merge) |
|---|---|---|
| `./src/app-layer/usecases/` | 90.55% statements | **75.98%** |
| `./src/lib/` | 90.26% | **82.05%** |
| `./src/app-layer/policies/` | 92.85% | **92.85%** |

The covered-statement count for `usecases/` was **identical** across the
two runs — 14512 both times. The denominator moved: 16025 → 21925, on
113 files whose source had not changed. Two files were genuinely newly
enrolled and account for 29 of those statements.

istanbul merges two entries for the same file by LOCATION. That is
correct when both came from the same instrumentation — it is how four
shards' hits accumulate — and unsound when they did not:

```
src/app-layer/usecases/access-review-connected.ts   (201 lines)
  shard 1, a test loaded it   →  69 statements, 30 branches, 10 fns,  0 null end-columns
  shards 2-4, zero-filled     → 121 statements, 53 branches, 17 fns, 18 null end-columns
```

The 121 map is a strict superset of the 69. Union it and the file reports
its 62 real hits against 121 statements — 51% for a file that is 90%
covered. **312 of 754 files carried more than one shape.**
`policies/` is the control: all 16 of its files are loaded in every
shard, so none is ever zero-filled, and its numbers are bit-identical
before and after.

The cause is the multi-project split. Locally:

```
npx jest <test> --selectProjects node   --coverage --collectCoverageFrom=<the file>   →  69
npx jest <test> --selectProjects jsdom  --coverage --collectCoverageFrom=<the file>   →  69
npx jest <node test> <rendered test>    --coverage --collectCoverageFrom=<the file>   → 121
```

Both contexts zero-fill the same file — the dedupe guard in
`_addUntestedFiles` is evaluated before either instrumentation lands — and
what is written is neither project's map. Null end-columns are the
fingerprint of source-map remapping. Note that each project ALONE
produces the same 69 statements (they differ only in branches, 30 vs 24,
which is the ES2017-vs-ES2020 target difference); the 121 shape appears
only when they run together, so it is an artefact of the combination
rather than of either config.

`mergeShardFiles` therefore groups a file's entries by statement-map
shape, merges within each group, and keeps the group that observed the
most coverage. Hits recorded against a minority shape are discarded —
there is no sound mapping between two coordinate spaces — and the count
is printed on every run.

**Open question, deliberately left open.** Why the combined run produces
a third map is not established; the reproduction above is the handle for
anyone who wants to pursue it upstream. Fixing it there would let the
normalisation be deleted, which is the outcome to prefer. Until then the
gate is robust to it and says so out loud.

### The residue it does not fix

A file that NO shard covers is zero-filled by both contexts in every
shard, so all four entries carry the same merged-context map and there is
no minority to discard. Those files count against a denominator ~1.7×
their true statement count. The distortion is conservative — it can only
understate — and it is bounded: the groups measured above clear their
floors with it in place.

## What the corrected gate measures

Run 31478710093, the first trustworthy measurement:

| group | files | statements | branches | functions | lines |
|---|---|---|---|---|---|
| `global` | 266 | 87.12 | 80.90 | 82.85 | 88.62 |
| `./src/app-layer/usecases/` | 176 | 90.39 | 79.60 | 85.81 | 91.81 |
| `./src/app-layer/policies/` | 16 | 92.85 | 87.50 | 96.25 | 93.70 |
| `./src/app-layer/events/` | 6 | 87.79 | 76.34 | 85.71 | 89.16 |
| `./src/lib/` | 296 | 89.49 | 78.50 | 80.73 | 91.07 |

`global` stops being "the ~1001 files some test imported, three quarters
of them React" and becomes the 266 `src/app-layer/` files outside the
tier-A/B folders, all zero-filled. Its floor is re-seeded ~1.5-2pp under
the measurement at **85 / 79 / 81 / 87**; `RATCHET_FLOOR.global` is
hardened from 63/62/77/76 to the previously enforced 65/64/78/77. Both
moves are upward. The other four floors are unchanged.

`./src/lib/` functions came in at **80.73% against an 81 floor** — a
0.27pp miss, and the only group that did not clear. The cause is
population, not regression: files that were invisible to the old report
now count, including seven that had never been loaded by any test. The
policy's answer to a miss is to add the missing test, so the gap was
repaid with three of them rather than by moving the floor:

| file | why it was worth testing | result |
|---|---|---|
| `src/lib/audit/activity-humanize.ts` | Produces the i18n keys the dashboard activity feed renders. An invented token renders as `dashboard.activity.verb.FROBNICATED` on a customer's dashboard; a wrong `path()` is a 404 the feed shows as a working link. 13 functions, no test. | 100% |
| `src/lib/api-error.ts` | Its own docstring: the bug it prevents is "objects are not valid as a React child", which only fires on a 4xx/5xx — exactly when the operator needs to read the message. | 100% |
| `src/lib/mcp/strict-receipt-guard.ts` | The pipelock strict-mode default is a decision (enforcing before pipelock fronts every agent would break the MCP surface) and nothing asserted it in either direction. | 100% |

## Files

| file | role |
|---|---|
| `jest.config.js` | `collectCoverageFrom` to the top level; `coveragePathIgnorePatterns` onto both projects; co-located tests out of the scope and `src/lib/**/*.tsx` into it; the three comment blocks that stated the opposite rewritten |
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
- **The normalisation was validated before it was written.** The rule was
  run over the real artifacts of run 31473460650 first: it had to restore
  `policies/` and `events/` bit-identically and land `usecases/` within a
  rounding step of its pre-change 90.55%, or the diagnosis was wrong. It
  did (92.85 / 87.79 / 90.39). Only then was it worth implementing. A
  normalisation that merely made the number look plausible would have
  been indistinguishable from lowering a floor.
- **`.tsx` under `src/lib/` is in scope; `src/components/**` is not.**
  The line is what the file IS, not what extension it carries: context
  providers and the keyboard-shortcut hook are shared library code that
  the app depends on everywhere, and the `./src/lib/` floor was earned
  partly on them. React pages and components keep their own assurance
  model, which is a population floor rather than a percentage.
