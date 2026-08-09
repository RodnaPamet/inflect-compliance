# 2026-08-10 — Audits: consolidating duplicated domain logic, dropping dead schema

**Commit:** `<pending>` refactor(audits): one readiness-band definition, scoring into its module, drop dead breakdownJson, split the audit schema

Six items, none user-visible. What connects them is that each is a *second*
occurrence: a duplication that had already been extracted once and regrew, an
allowlist that had already been narrowed once, a module boundary that had
already been crossed once elsewhere. So the work is less about the edits than
about which of them come with a rule attached.

## Design

### The readiness bands regrew, and why

80 and 50 separate "ready to be audited" / "nearly there" / "at risk". They
appeared six times across four files in **three** output vocabularies:
`success|attention|critical` (KPI tone), `success|warning|error` (badge
variant), and raw hex (SVG stroke).

This had been fixed once. `<ReadinessScoreRing>` exists *because* these bands
"were previously undocumented magic numbers duplicated in two files" — and they
grew back, including into `cycles/[cycleId]/readiness/page.tsx`, one of the two
files the ring was extracted from.

The reason it regrew is the interesting part: **the extraction moved the
rendering but not the rule.** A surface that needed the band in a vocabulary
the extracted component did not speak had nowhere to ask, so it re-derived the
band from the numbers. Extracting a component does not stop that; extracting a
*rule* with a slot for new vocabularies does.

`src/lib/readiness/bands.ts` is that rule: `readinessBand(score)` plus one map
per vocabulary. Adding a surface means adding a map, which is cheaper than
re-reading the thresholds — that price difference is the whole mechanism.

The scoring engine's recommendation prose went through the same door. It had
its own `coverage < 50` / `coverage < 80` copies, so a dimension could paint
amber while its advice was worded for red.

### An allowlist that exempts new code inverts the ratchet

`chart-token-discipline` polices raw hex — via a hand-maintained `SCAN_FILES`
list, rationale "keep the scope tight so it's actionable". The effect: a NEW
chart component is exempt by default. `ReadinessScoreRing` shipped three raw
hex values and no ratchet could see them, because nothing adds a file to a list
it does not know exists.

It is now a glob over chart-shaped filenames plus the `charts/` directory: 9
files → 41. Measured before switching — the only pre-existing hits across the
widened net were PR references inside comments (`#536`, `#753`), so adoption
cost nothing. Two further changes made the wider net honest rather than noisy:

- `var(--token, #hex)` is **token-first with a degradation fallback** — the
  opposite of the failure being policed. Handled as a rule, not five allowlist
  rows, because a pattern that recurs is a rule.
- JSX comments (`{/* … */}`) were not being skipped, so `pre-#536` read as a
  colour.

Three exceptions remain, each with a written reason (specular highlight,
resolver fallback, Tailwind hairline).

### A write-only column with two shapes

`ReadinessSnapshot.breakdownJson` was written by two engines in incompatible
shapes — the ISO/generic scorer wrote a full `ReadinessBreakdown`, the NIS2
scorer wrote `{ byDomain, fineExposureGaps }` — with no discriminator beyond
`frameworkKey`. Both read paths use an explicit `select` that omitted it. The
schema comment claimed "Read-side joins this for the trend chart's tooltips";
no such reader ever existed.

Dropped. It was the heaviest column on the model, written on every score
change, and nothing could have read it safely anyway. The trend chart renders
`score` + `gapCount`, which stay.

The two writers also disagreed about **what a snapshot means**: the ISO scorer
skipped the write when the score was unchanged, the NIS2 scorer always wrote.
For one engine a point on the trend line was a change, for the other an event.
They now agree on "a snapshot records a change" — which is what a trend line
reads as, and which stops a re-run of the assessment flattening the chart with
duplicate points.

### A module boundary crossed twice

`audit-readiness/overview.ts` imported `scoreReadiness` from
`'../audit-readiness-scoring'` — 848 lines of the same domain, one directory
up, absent from the barrel. Consumers therefore imported the deep path and the
barrel's curated surface was a half-truth. Second confirmed instance of the
pattern (`control/health.ts` → `'../control-test'` was the first), so it is a
habit rather than an accident.

Moved to `audit-readiness/scoring.ts` and re-exported. The barrel keeps its
good property — curated named re-exports, not `export *`.

Note on where the bands live: the engine owns them, but `bands.ts` is a
dependency-free leaf that both the engine and client components import. A
client importing the scoring module directly would drag Prisma into the browser
bundle; the engine re-exports the bands so server callers still reach them
through the domain.

### Audit ≠ AuditLog

Of the 20 `audit*` files in `tests/unit/`, sixteen tested the platform's
hash-chained trail and four tested the compliance-audit workflow. No functional
confusion was found — no wrong import, no method on the wrong repository — so
this is a comprehension cost, not a correctness one, and the fix is priced
accordingly.

`audit.prisma` split into `audit-trail.prisma` (AuditLog, OrgAuditLog) and
`audit-workflow.prisma` (Audit, AuditCycle, AuditPack…), a pure reorg of the
same shape as the 2026-07-10 `compliance.prisma` split. The sixteen trail test
files take an `audit-trail-` prefix; `tests/unit/audit/` becomes
`tests/unit/audit-trail/`. **Models are deliberately not renamed** — that churn
would exceed the benefit.

### A comment that described a live page as removed

`ReadinessScoreRing`'s docstring called `/audits/readiness` "now-removed". The
page exists. It was a redirect shim, and it came back as the one surface that
rolls readiness up across every framework — which the per-cycle list cannot do.

This was not harmless: its return is what reintroduced four of the six
threshold copies, because the comment said the file it would have copied from
no longer existed. Corrected, with the reason the page came back recorded next
to it.

## Files

| File | Role |
| --- | --- |
| `src/lib/readiness/bands.ts` | new — the one definition + three vocabulary maps |
| `src/app-layer/usecases/audit-readiness/scoring.ts` | moved from `usecases/audit-readiness-scoring.ts`; recommendations use the band; re-exports it |
| `src/app-layer/usecases/audit-readiness/index.ts` | barrel now carries the scoring surface |
| `src/app-layer/usecases/nis2-readiness.ts` | dedupe aligned; `PRIORITY_TIER_MIN` named so its 50 cannot be confused with the band's |
| `src/app/t/…/audits/cycles/ReadinessScoreRing.tsx` | tokens not hex; corrected history |
| `src/app/t/…/audits/readiness/ReadinessOverviewClient.tsx` | four sites → `readinessTone` / `readinessVariant` |
| `src/app/t/…/audits/cycles/[cycleId]/readiness/page.tsx` | one site → `readinessVariant` |
| `prisma/schema/audit-trail.prisma` · `audit-workflow.prisma` | the split; `audit.prisma` removed |
| `prisma/migrations/20260810090000_drop_readiness_snapshot_breakdown_json/` | drops the column |
| `tests/guards/chart-token-discipline.test.ts` | glob + var-fallback rule + JSX-comment skip |
| `tests/guards/readiness-band-single-definition.test.ts` | new — bans the literals outside the definition |
| `tests/unit/readiness-bands.test.ts` | new — boundaries and cross-vocabulary agreement |
| `tests/unit/audit-trail-*.test.ts`, `tests/unit/audit-trail/` | the sixteen renames |

## Decisions

- **Ratchet the rule, not the refactor.** The band guard does not assert that
  the extraction happened — it asserts the numbers cannot come back. Asserting
  the refactor is what the first attempt effectively did, and it passed for
  months while the duplication regrew beside it.

- **`PRIORITY_TIER_MIN` instead of an allowlist entry.** `nis2-readiness.ts`
  has `p >= 50` on a completely different scale (unbounded weighted priority,
  not a percentage). Naming the constant removes the collision at the source;
  an exception row would have preserved it and asked every future reader to
  re-derive that the two 50s are unrelated.

- **Dropped `breakdownJson` rather than wiring the promised reader.** With two
  incompatible shapes and no discriminator, "wire the reader" means first
  choosing a shape and backfilling — real work in service of a tooltip that
  already renders from `score` + `gapCount`.

- **Models not renamed in the schema split.** The prompt's own judgement, and
  it is right: `AuditLog` → `PlatformAuditLog` touches every usecase, every
  repository, and every migration's raw SQL, to fix a comprehension cost that
  the file split already fixes.

- **The glob was measured before it was adopted.** A widened ratchet that turns
  CI red on 40 unrelated files is a widened ratchet that gets narrowed again
  next week. Counting the offenders first (five files, all explicable by two
  rules and three exceptions) is what made it safe to keep.
