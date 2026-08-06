# 2026-08-06 — Retiring the rq* epic ratchets, and closing the loop that fed them

**Commit:** _(see branch `chore/retire-rq-epic-ratchets`)_

Follow-on to `2026-08-05-retire-epic-ratchets.md` (#1790). That sweep retired
153 epic-named guards and wrote the rule. This one fixes the hole in it and
removes the mechanism that made the rule expensive to follow.

## Design

### The hole

`no-epic-named-ratchets.test.ts` recognises `b\d+-`, `item-\d+`, `r\d+-`,
`epic\d+`, `pr-` and `roadmap-\d+`. It does **not** recognise `rq`. So the
entire risk-quantification family — 41 files — passed straight through a sweep
that existed precisely to catch them. Nothing was wrong with the rule; the
pattern list just had a gap, and a pattern list is only as good as its worst
omission.

Adding `^rq\d` outright would have failed CI on 39 files at once, several of
which are the only written record of a contract that has to become a
behavioural test *before* the file can go. So it is a **downward ratchet**
instead — the shape the repo already uses for `as any`. New `rq`-named guards
are blocked today; the existing ones leave in tranches, each lowering the
ceiling. Slack cannot accumulate: the assertion is `toBe(CEILING)`, not
`toBeLessThanOrEqual`.

### The loop

`tests/guards/rq3-11-capstone.test.ts` `readdirSync`'d `tests/guards/`,
filtered `rq3-*.test.ts`, and required every filename to appear as a
**substring of a markdown file**. Read the incentive it created:

```
ship an RQ3 follow-up
  → convention says: add an rq3-*.test.ts ratchet
    → capstone goes red until the filename is pasted into prose
      → the file you added is itself another source-regex ratchet
        → repeat
```

The cheapest path to green was *writing more ratchets*. It also gated CI on
`String.includes` over prose: it verified **mention, not accuracy**, so a row
describing behaviour that had since changed passed happily.

Deleted. The index check moved to `npm run docs:lint` — advisory, human-read,
exit 0. A doc index is worth keeping honest; it is not worth a build gate.

`risk-quantification-integrity.test.ts` went the same way. 30 of its 32
assertions were `existsSync` over a hand-maintained epic → file table. Deleting
`fair-calculator.ts` fails its own 14 numeric tests first, with a message that
names the arithmetic rather than "expected true, received false". Its one
irreplaceable check — the three cross-tenant risk crons — moved to
`register-schedules.test.ts` and now imports `SCHEDULED_JOBS` instead of
regex-matching the source. That check earns its place because every other test
in that file *iterates* the array and is therefore self-referential: delete the
`risk-snapshot` entry and they all still pass, having verified a shorter array,
while the daily snapshot silently stops.

### The brittleness tax

Nine files carried assertions that could not fail for a real reason:

| Shape | Example | Why it had to go |
| --- | --- | --- |
| UI prose | `/\(mean — run a simulation for tails\)/` | An **em-dash in copy** was CI-load-bearing. Copy-editing broke the build. |
| Loop-variable names | `formatTailAwareAle\(row\.ale, …` / `\(f\.ale, …` | Renaming `f` to `finding` failed. |
| Magic byte offsets | `dashboard.indexOf('risk-stale-row-') - 800, … + 400` | An upstream comment slid the window off the target — silently. |
| Declaration-name slices | `indexOf('const acceptSuggestion')` → `indexOf('const saveResidualOverride')` | **Reordering** two functions yields a backwards slice: empty, so every `not.toMatch` in it passes while checking nothing. |
| Formula text | `/\(d\.min \+ 4 \* d\.mode \+ d\.max\) \/ 6/` | A mathematically identical reordering fails; `fair-calculator.test.ts` already proves `pertMean` numerically. A regex cannot check arithmetic. |
| Constant declaration text | `/MAX_REDUCTION = 0\.8/` | Pins the spelling, not the value. Import it. |
| JSX attribute order | `/<MonteCarloPanel appetite=\{appetite\}/` | Adding any prop *before* `appetite` failed. |

Where the intent was real it was kept and re-expressed. Two cases came out
**stronger** than what they replaced:

- `rq3-5` asserted "the collision callout does not filter by score" inside a
  byte window. `filterCtx.set('score'` appears **nowhere** in the file, so the
  assertion is now file-wide — a strictly stronger claim that no markup move
  can slide out from under.
- `rq3-4` asserted two call sites by loop-variable name. It now asserts that
  **no ALE anywhere on the dashboard is formatted as a bare mean**, which is
  the regression class the file's own docblock claims to guard, and which
  stays true as widgets are added.

Byte-offset and name-slice extraction is replaced by `declarationOf()` in
`tests/helpers/source-blocks.ts`, which bounds a declaration by its own
punctuation. Its first version matched the first `{` after the declaration and
was **wrong** for `const x = useMemo(() => rows.filter(…).map((r) => ({ … })))`
— the first brace is the mapped object literal, so the extract excluded the
`.filter(…)` predicate the assertion was about. Caught by running it. It now
tracks `()`, `[]` and `{}` together and stops at the top-level `;`.

## Files

| File | Role |
| --- | --- |
| `tests/guards/rq3-11-capstone.test.ts` | DELETED — the auto-catalytic loop |
| `tests/guards/risk-quantification-integrity.test.ts` | DELETED — 30 `existsSync` assertions |
| `scripts/docs-lint.mjs` + `package.json` | `npm run docs:lint` — the index check, advisory |
| `tests/unit/jobs/register-schedules.test.ts` | Rehomes the three-cron invariant, import-based |
| `tests/helpers/source-blocks.ts` | `declarationOf()` — bound a source read by punctuation |
| `tests/guards/rq3-4-tail-language.test.ts` | Prose + loop-var + byte window out; no-bare-mean in |
| `tests/guards/rq3-ob-c-tab-deep-links.test.ts` | Three byte windows → deep-link count |
| `tests/guards/rq2-4-assessment-ia.test.ts`, `rq2-9-matrix-movement.test.ts`, `rq2-6-appetite-lec.test.ts` | Name-slices → `declarationOf` |
| `tests/guards/rq3-5-histograms.test.ts` | Region slice → file-wide negative |
| `tests/guards/rq3-2-range-first.test.ts`, `rq3-1-simulated-lec.test.ts` | Formula text, JSX attribute order |
| `tests/guards/rq2-8-staleness.test.ts`, `tests/guardrails/risk-score-provenance.test.ts` | Constant text → imported value |
| `tests/guards/no-epic-named-ratchets.test.ts` | The `rq*` downward ratchet |
| `CLAUDE.md`, `docs/rq3-roadmap-complete.md`, `docs/risk-quantification.md` | Policy + the docs that prescribed the retired convention |

## Decisions

- **A ratchet, not 39 allowlist entries.** `ALLOWED` distinguishes "kept on
  purpose"; the `rq` files are "not yet retired". A single number that only
  goes down says that honestly and gives the next PR a target, where 39
  near-identical reason strings would just be noise to skim past.
- **The docs that prescribed the convention were changed, not just the code.**
  `rq3-roadmap-complete.md` told future waves to ship "one ratchet per
  implementation note" — leaving that in place would have re-created the
  family under a new prefix. Reconciling "ratchet every PR" with this rule is
  now written down explicitly in CLAUDE.md rather than left for a reader to
  infer: ship a test that fails when the behaviour regresses; stop pinning the
  shape of the diff you just wrote.
- **The implementation note for the deleted capstone was left alone.**
  `docs/implementation-notes/` is historical by path and read-only. It records
  what was true on 2026-06-13, and it was.
- **`docs:lint` is deliberately not in CI**, including not as a non-blocking
  job. A red-but-ignored check trains people to ignore checks.
