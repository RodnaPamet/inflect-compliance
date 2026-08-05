# 2026-08-05 — Migrating source-text guards to AST lint rules

**Commit:** `<pending> refactor(lint): move platform bans from regex guards to ESLint selectors`

Step 2 of the systemic item, and the first tranche of it. Two guards moved
from `readFileSync` + regex into `no-restricted-syntax` selectors in
`eslint.config.mjs`. This note exists mainly to record **the migration
procedure**, because the remaining candidates should follow it exactly.

## Why an AST rule beats a regex over source text

A regex sees characters; a selector sees the program. Three consequences,
all of them visible in the two guards migrated here:

1. **Comments.** `date-input-rollout.test.ts` carried a bespoke
   `stripComments()` helper — 12 lines stripping JSX block comments, block
   comments and line comments — for no reason other than that a migration
   note *mentioning* `<input type="date">` would otherwise fail the build.
   An AST selector never sees a comment, so the helper and the entire class
   of false positive disappear.
2. **Formatting.** A regex like
   `/font-mono[^"]*text-xs[^"]*text-content-muted[^"]*tabular-nums/` breaks
   the day anyone runs a Tailwind class sorter. A selector matches the node
   regardless of whitespace, attribute order, or line breaks.
3. **Where the failure appears.** A guard fails in a Jest run, minutes
   later, naming a file and line. A lint rule fails in the editor, on the
   offending node, with the message attached to the code — which is the
   difference between a rule people follow and a rule people work around.

## Migrated

| Was | Now |
| --- | --- |
| `tests/guards/no-inline-clipboard.test.ts` (Epic 56) | `no-restricted-syntax` — `CallExpression[callee.object.object.name='navigator'][callee.object.property.name='clipboard'][callee.property.name=/^(writeText\|write)$/]` |
| `tests/guardrails/date-input-rollout.test.ts` (Epic 58) | `no-restricted-syntax` — `JSXOpeningElement[name.name=/^[iI]nput$/]:has(JSXAttribute[name.name='type'][value.value=/^(date\|datetime-local)$/])` |

Allowlists became `files:` override blocks rather than in-rule path arrays,
so an exemption is scoped to the file it is granted to instead of being
matched by path string. The two clipboard exemptions (the shared hook, and
`canvas-export.ts` writing an `image/png` ClipboardItem) carry their reasons
at the override.

## The procedure — four checks, all of them load-bearing

A migration is only safe if the new rule does **exactly** what the old guard
did. Two of these four checks caught a real problem in this tranche.

1. **The rule fires.** Lint a synthetic file containing each violation
   shape. A selector with a typo silently matches nothing, and a rule that
   matches nothing looks identical to a codebase that is clean.
   *(Result: 4/4 probe violations caught.)*
2. **The rule is silent on the current tree.** The guard being replaced was
   passing, so the new rule must report zero. A non-zero count means the
   selector is broader than the regex was.
3. **The scope is unchanged.** ← *this one bit.* The guards scanned app
   source; `npm run lint` runs `eslint .` over the **whole repo**, including
   `tests/`. `tests/rendered/form-field.test.tsx:175` renders
   `<Input type="date" />` on purpose, to prove the FormField primitive
   handles one — so the naive migration would have failed CI on a
   legitimate test. Fixed with `'no-restricted-syntax': 'off'` in the
   existing `tests/**` override, restoring the original scope. A migration
   should move a rule, not quietly change what it covers.
4. **What ESLint cannot express stays behind.** ← *this one too.*
   `date-input-rollout.test.ts` was not purely a ban: it also asserted that
   `docs/date-picker.md` still contains the four sections the failure
   message points contributors at. That is not a lint rule, and deleting the
   file wholesale would have dropped it. The file was slimmed to that single
   assertion and renamed `date-picker-guide.test.ts` — a rule whose
   explanation has been gutted is a rule people work around.

## Scope of this tranche, honestly

Two guards, not the ~50 the roadmap item sketches. The procedure above is
four verification steps per rule, and two of the four found real problems in
a sample of two — which is the argument for doing the rest deliberately
rather than in a sweep. The candidates are already identified: 43 guards in
the suite are predominantly ban-shaped (`.not.toMatch` / `toEqual([])`
assertions outnumbering positive ones).

Not every one of those should move. `no-auto-join`,
`tenant-isolation-forward-lock` and `security-gate-strictness` are
architectural invariants over *relationships between files* — a per-file AST
rule cannot express "only these five call sites may create a
TenantMembership". Those stay as guards, and that is the correct outcome,
not a gap.

## Decisions

- **Scope parity over stricter enforcement.** Widening a rule during a
  migration hides the widening inside a refactor. If `tests/` should be
  covered, that is its own change with its own justification.
- **Allowlists as `files:` overrides.** A path string in an array drifts
  silently when a file moves; an override block moves with the config and
  fails visibly.
- **Probes are mandatory, not optional.** The failure mode of a bad selector
  is silence, which is indistinguishable from success — the same trap as a
  CI check that never ran.
