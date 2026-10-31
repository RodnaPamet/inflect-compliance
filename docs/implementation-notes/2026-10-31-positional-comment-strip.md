# 2026-10-31 — Tests stop stripping comments by position (#4659)

## Design

Before this change, 122 files under `tests/` stripped comments with a regex
before matching source:

```js
src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
```

Both halves pair delimiters by position. A string holding `/*` opens a comment
that runs to the next `*/` anywhere further down, and a string holding `//` (a
URL, a path) loses the rest of its line. The deleted region is never read, so
a guard asserting that a pattern is absent passes on code it did not see.
#4655 measured one case: `border-tone-budget` read 106 where the tree held 108.

The 117 block strips and 121 line strips were replaced with `codeOf`, or
`cssCodeOf` for stylesheets. Both mask lexically: strings, template literals
and regex literals are scanned as such (#4658, #4665). They BLANK a comment to
spaces rather than delete it, so offsets and line numbers still line up with
the file.

Most of the edits were made by a TypeScript-AST codemod over the
`.replace(<strip>, …)` chains. Three wrappers that were not chains were
converted by hand, and so were three `'use client'` head-strips, which removed
leading comments to find the directive.

**Verdicts.** Every test that reads through a migrated strip ran before and
after: the 120 test files that lost one, `border-tone-budget`, and the four
suites that import the two migrated helpers (`prisma-enum-order`,
`proto-messages`). That is 1,184 tests, and every one passed both times. Four
failed during the migration, and none of them was a guard that had been
passing falsely:

- **`ssrf-egress-coverage`.** The codemod's import shadowed the file's own
  local `codeOf`. The import is now aliased.
- **`border-tone-budget`.** Its `oldRegexCount` exists to show what the old
  strip got wrong (#4636). Migrating it erased the contrast, so it keeps the
  old strip, under an `eslint-disable` that says why.
- **`soa-gate-is-declared-not-inferred`.** Its positive control asserted the
  DELETED output. It now asserts the blanked output, plus a URL case.
- **`auth-test-mode-prod-refusal`.** A fixed-length window that used to reach
  the end of a declaration now holds blanked comment bytes instead. The window
  is now bounded by the declaration's own end.

None of the migrated assertions is wrong on today's tree. That matches the
issue's estimate that exposure is narrow: 23 of 3,385 source files carry a
string with a comment delimiter. The change protects the assertions from the
next such file.

**The case table.** `tests/unit/source-blocks-helpers.test.ts` holds the six
cases the issue names: a string with `/*`, one with `*/`, one with `//`, a URL,
a regex literal containing a quote, and a JSX comment. For each, it asserts
that `codeOf` keeps the code and blanks the comment. Where the old strip lost
code, it asserts that too. A vacuity check needs at least one case the old
strip got right, so the table cannot pass by failing everything.

**The rule.** `local/no-positional-comment-strip` is an error in `tests/**`. It
reports a regex literal passed as the pattern of `.replace` or `.replaceAll`
whose source is the block strip or the line strip. Only a replace deletes text,
so a regex that MATCHES code allowing an optional comment line is left alone.

**The analyser.** `tests/helpers/assertion-reach.ts` followed a local helper
only when its body was a `.replace` chain. A helper that became
`return codeOf(x)` therefore counted as un-analysable, and the Class D skip
count rose by 31. The analyser now follows a call to an imported masker inside
a local wrapper. That brings `UNANALYSABLE_READ_BASELINE` to 1370, 17 below
where it started. Two needles in `calendar-connections-route-gate` became
ambiguous once the analyser could read that file, and were narrowed to the
statement they name.

## Files

| File | Role |
| --- | --- |
| 120 test files and 2 helpers under `tests/` | strip chains replaced with `codeOf` / `cssCodeOf` |
| `eslint-rules/rules/no-positional-comment-strip.js` | the rule |
| `eslint-rules/__tests__/no-positional-comment-strip.test.ts` | its `RuleTester` cases, valid and invalid |
| `eslint-rules/index.js`, `eslint.config.mjs` | registers the rule and enables it for `tests/**` |
| `tests/guards/eslint-local-rules-wired.test.ts` | the rule joins the wiring census |
| `tests/unit/source-blocks-helpers.test.ts` | the case table |
| `tests/helpers/assertion-reach.ts` | follows an imported masker inside a local wrapper |
| `tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts` | baseline 1387 → 1370 |

## Decisions

- **Blank, not delete.** `codeOf` keeps length and line count, which every
  `source-blocks` extractor relies on. Three tests that measured the deleted
  output were changed to measure the blanked output. Adding a delete mode
  would have created a second masker for the next author to choose between.
- **The rule matches `.replace` arguments only.** Matching every regex literal
  also flagged patterns that read past an optional comment line. Those patterns
  delete nothing, so flagging them would only have produced disable comments.
- **What the rule cannot see is stated in its docblock.** A pattern built with
  `new RegExp` or held in a variable is not caught. No such strip exists in
  `tests/` today, and the inline literal is how the pattern spread.
- **`tests/` only.** `scripts/docs-reference/roles.ts` strips `//` from
  Prisma enum lines, which hold identifiers and no strings.
  `scripts/worker.ts` redacts a URL's credentials, which is not a comment
  strip. Neither is in the issue's population.
