# 2026-08-05 — Retire the shipped epic ratchets

**Commit:** `<pending> test: retire shipped epic ratchets`

153 guard files deleted (~22,500 lines), 4 renamed, 1 rule added. The guard
suite goes from **777 files to 624**. No production code changes.

## Why

The suite had grown to 775 of 2,011 test files. 761 of those were pure
`readFileSync` + regex over source text; 35 carried hardcoded numeric
baselines; 113 carried exemption arrays. **29 distinct guard files regexed
`AssetsClient.tsx` alone.**

That last number is the whole argument. Extracting a shared helper out of
`AssetsClient.tsx` meant repairing 29 files' worth of source-string
assertions — so copy-paste was, every single time, the locally rational
choice. The suite was not protecting the codebase from duplication; it was
holding the duplication in place.

The specific failure of an epic-named guard is that it locks the **shape of
one PR's diff**. It cannot catch a regression the type system would miss,
because the code it guards is imported and type-checked at its real call
sites. What it *can* do is fail when someone renames a variable, sorts
Tailwind classes, reformats, or extracts a helper. Structurally, its
true-positive rate is zero and its false-positive rate rises with how much
you improve the code.

Representative examples from the retired set:

| Guard | Asserts |
| --- | --- |
| `r13-band-shimmer` | a keyframe name in `tailwind.config.js` and that it animates `background-position` |
| `b7-asset-risk-tasks-column` | the literal source string `/static async countLinkedToEntities/` |
| `item-27-32-34-asset-ux` | the literal variable name `handleAssetRowClick` |
| `pr-asset-control-codes` | `/font-mono[^"]*text-xs[^"]*text-content-muted[^"]*tabular-nums/` — any class sorter breaks it |

## What was kept, and why

Deletion was **not** by filename pattern. Every epic-named file was checked
for whether another surviving test referenced it by name, because several
"capstone" guards assert that other guards exist — deleting a guarded file
without its capstone would have broken CI.

Ten survived:

- **Nine** are referenced by name from a non-epic guard
  (`single-task-model`, `behavioural-coverage-registry`,
  `motion-language-discipline`, `mobile-roadmap-integrity`,
  `donut-chart-centering`, `inline-subtitle-budget`,
  `interaction-state-discipline`, `no-explicit-any-ratchet`).
- **Three** are documented in `CLAUDE.md` as live platform rules
  (`epic52-datatable-ratchet`, `epic60-ratchet`, `r14-no-page-searchbars`) —
  two of which overlap with the nine.

A second pass caught five files the first sweep's two-digit regex missed
(`b10-*`, `r5-*`). These were triaged individually, and four turned out to
carry **real security invariants the type system cannot reach**:

| Was | Now | Invariant |
| --- | --- | --- |
| `r5-p1-evidence-download-security` | `evidence-download-authz` | `downloadFile` / `downloadEvidenceFile` gate on `isDownloadAllowed` |
| `r5-p2-evidence-review-authz` | `evidence-review-authz` | Approve/Reject requires `canAdmin`; re-upload resets APPROVED → SUBMITTED |
| `r5-p3-evidence-resilience` | `evidence-list-resilience` | metadata parsed through Zod with the folder cap + reviewCycle enum |
| `b10-advanced-analytics` | `risk-quantitative-analytics` | the analytics usecase asserts read permission before touching the DB |

Those were **renamed, not deleted**. The invariant was worth keeping; only
the name was wrong. The fifth (`b10-create-button-dark-contrast`, which
asserts a colour token) was deleted.

## The rule going forward

`tests/guards/no-epic-named-ratchets.test.ts` fails CI on any new guard whose
filename is anchored on `b\d+-`, `item-\d+`, `r\d+-`, `epic\d+`, `pr-`, or
`roadmap-\d+`. Its `ALLOWED` map holds the ten survivors, each with a written
reason. Three supporting assertions keep the rule honest: allowlist entries
must still exist, must carry a real reason, and the total guard count must
stay under 700 (so a bulk restore cannot quietly undo this).

Two directions it points contributors:

- Name a guard for the **invariant** it protects.
  `no-client-side-filtering`, `rls-coverage`, `encryption-key-enforcement`
  all still make sense years after the PR that added them.
  `b7-asset-risk-tasks-column` never will.
- If the rule is structural — banned import, required prop, forbidden
  identifier, naming convention — write an **ESLint rule**. An AST rule
  survives reformatting and renaming; a regex over source text does not.

## Verification

The load-bearing check is that nothing which survived depended on what was
removed: the full surviving suite runs **623 files / 8,901 tests green**.
`npx tsc --noEmit` is clean. The deletions landed as six commits grouped by
family so the history is reviewable family-by-family rather than as one
153-file diff.

## Decisions

- **Deleted by dependency analysis, not by filename.** The capstone guards
  that assert other guards exist made a pattern-based sweep unsafe; the
  reference graph was computed first and drove the keep list.
- **Renaming beat deleting for the four security guards.** The prompt's
  argument is about *diff-shape locks*, and those four are not that. Applying
  the rule mechanically would have dropped real authorization assertions.
- **The count assertion is a floor, not a budget.** `< 700` catches a bulk
  restore. It deliberately leaves room for legitimate new invariant-named
  guards, because the goal is fewer *worthless* guards, not fewer guards.
- **This is step 1 of the systemic item.** Migrating the surviving
  source-text guards to AST lint rules, and deleting the meta-tests that
  assert on other tests, are separate follow-ups — the suite had to shrink
  before either is affordable.
