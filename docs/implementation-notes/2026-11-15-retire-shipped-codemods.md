# 2026-11-15 — retire `scripts/codemods/`

**Commit:** (this change)

Owner decision, 2026-11-15, taken on the measurements below rather than on the
two audit findings that prompted the question (#5667, #5668 from the
low-severity bundle #5315). Both are closed by removal.

## Design

The directory held five one-shot migration scripts written for the UI epics —
PR-3 (typography), PR-6 (Card density) and the #3046 shared-UI move. Each
rewrote source text in place and was run once, by hand, in the pull request that
introduced it. None was ever wired to anything: no `package.json` script, no CI
job, no documented step. The directory's only commits are the three migrations
themselves (`768c81169`, `5c43b4af1`, `1ff04991c`).

This is the same call as the 2026-08-05 retirement of 153 epic-named ratchets
(`docs/implementation-notes/2026-08-05-retire-epic-ratchets.md`): an artefact
that locks the shape of one shipped diff, kept past the diff.

## Why now, and what was measured

The audit asked for two fixes. Measuring first showed what the scripts had left
to do:

| script | remaining targets |
| --- | --- |
| `glass-card-density-migration.js` | **0** `glass-card p-5` / `p-8` sites anywhere (the 20 surviving `glass-card` sites are the p-4 / p-6 / no-padding rungs its own docblock says it does not touch) |
| `raw-status-colors.js` | **0** in the `packages/ui` it claims to cover; the 4 matches in the set it does walk are all in `GraphExplorer.tsx`, which its own `EXCLUDE_VISUALIZATION_FILES` deliberately excludes as a 4-colour category palette |
| `raw-status-colors-cleanup.js` | **0** by construction — its docblock says it repairs a regex-ordering bug in its sibling's *initial run* |
| `badge-to-status-badge.js` | 1 |
| `heading-to-typography.js` | 16 |

So four of the five had nothing to migrate, and the fifth's 16 raw headings are
a hand edit, not a reason to keep a 2026 text-rewriter.

Against that, `glass-card-density-migration.js` was a live hazard. #5667
established, by reading, that its tag balancer pairs `"<Card"` by prefix (so
`<CardHeader>` increments the depth) and counts a self-closing `<div />` as an
open, and that its only guard is a count the failure does not change
(`c2.count !== c1.count`, with one `<Card>` opened and one `</Card>` written at
the wrong nesting). It therefore writes mismatched JSX, breaks the file's
compile, and reports `[applied]`. A script with no remaining work that corrupts
files when re-run has no upside to trade.

#5668's finding is the same class one level up: `TARGETS` never included
`packages/ui`, while a comment beside the `icons` exclusion told readers the
exclusion had been widened to cover it — a control whose stated scope was wider
than its real one, with two exclusion entries (`RiskHeatmap.tsx`,
`ExpiryCalendar.tsx`) that had rotted into no-ops when those files were deleted.
Nothing checked either claim against the tree.

## Files

| file | role |
| --- | --- |
| `scripts/codemods/*.js` (5 files) | deleted |
| `docs/shared-ui-package-design.md` | §5.3 counted 8 hardcoded source paths "across 3 files in `scripts/codemods/`" as part of the remaining migration work; that measurement is now stale, so the sentence says so |

## Decisions

- **Deleted rather than fixed.** Fixing #5667 properly means a tag-name
  boundary, a self-closing check, and replacing the count guard with a
  verification that can actually refuse — real work on a script with zero
  targets. The question was put to the owner with these numbers rather than
  decided here.
- **Deleted rather than left in place.** "Unwired, so it cannot hurt anyone"
  holds only until somebody runs it, and a file in `scripts/` reads as
  supported tooling. Git history keeps every script recoverable at the commit
  that ran it, which is the only revision anyone would want.
- **No replacement.** The migrations are finished. The 16 raw headings and the
  1 badge site are ordinary edits; the token ratchets under `tests/guards/`
  (`border-tone-budget`, `no-renegade-bg-tokens`, `content-token-validity` and
  their siblings) are what hold the line going forward, and they run in CI,
  which no codemod ever did.
- **The doc sentence was corrected, not deleted.** `shared-ui-package-design.md`
  is `living`, so its current-state claims have to be true; the measurement
  stays on the record with a note that those 8 paths are gone.
