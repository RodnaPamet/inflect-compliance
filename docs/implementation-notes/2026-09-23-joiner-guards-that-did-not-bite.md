# 2026-09-23 — four joiner guards that did not bite, and what replaced them

**Commit:** `<sha>` test(identity): make the joiner's window and its prediction limits mutation-proof

#2687's remaining acceptance is about GUARDS on behaviour that already works,
so the only way to discharge it is to break the behaviour on purpose and watch
what goes red. Twenty mutations were applied one at a time to
`jobs/identity-joiner.ts`, `usecases/identity-joiner-run.ts` and
`usecases/identity-joiner-pass.ts`, each run against the seven-suite joiner
population, each reverted with a byte copy verified by `filecmp`.

Sixteen of the twenty reddened a test. **Four did not**, and the four are the
whole value of the exercise: every one of them is a change that widens what the
artefact claims while leaving the suite green.

## The four

| # | mutation | pre | post |
| --- | --- | --- | --- |
| M11 | `utcDayWindow` widened from one UTC day to **two** | 0 failed | 1 failed |
| M12 | `utcDayWindow` floor moved **back one day** | 0 failed | 1 failed |
| P4 | limit 1 reworded: *"has never been attempted"* → *"is covered by this plan"* | 0 failed | 5 failed |
| P5 | the recorded limits **reversed** on the way into the row | 0 failed | 2 failed |

**M11 / M12 — the window had no edge.** A deleted `NOT_IN_WINDOW` arm reddened
three tests and a window widened to a YEAR reddened two, so the window looked
covered. It was not: both surviving assertions use a date a comfortable six or
seven days from `now`, and a date six days out is outside a two-day window as
surely as it is outside a one-day one. Nothing in the suite could tell one UTC
day from two, or from three, and "the run must not become an all-dates pass by
accident" is exactly the accident that arrives one day at a time.

**P4 — a topic word is not a claim.** The two assertions named for acceptance 3
matched `/HRIS write-back/i` and `/write-back/i`. Both are satisfied by a
sentence saying the OPPOSITE of what the limit says, so a limit rewritten to
promise the write-back is covered left all 111 tests green — an artefact
promising more than the run checked, with every guard for that criterion still
passing.

**P5 — `.some(...)` cannot see order.** Every assertion on the persisted side
was an existence check, so the recording could reverse the array, and (P6) could
also truncate each sentence at 80 characters with only one of the four needles
noticing. "Verbatim" was a word in a comment.

## The replacement

A second, independently written copy of the four limit sentences lives in
`tests/helpers/joiner-prediction-limits.ts`, and both ends of the seam assert
`toEqual` against it — the planner produces exactly those strings in that order
(`identity-joiner-pass.test.ts`), the artefact carries exactly those strings in
that order (`identity-joiner-run.test.ts`). Composed, that is the criterion:
what the planner said is what the row says, character for character.

It is deliberately NOT imported from `identity-joiner-pass.ts`. Reading the
constant the code under test writes would make both assertions tautologies; the
point is a copy that a source reword must DISAGREE with. Changing a limit
therefore costs a diff in the helper too, which is the intended price.

The window gets its two boundary milliseconds instead of a third comfortable
date: the first and last millisecond of the UTC day are `PLANNED`, the first
millisecond of the next day and the last of the previous are `NOT_IN_WINDOW`.
Any widening in either direction now has a test standing on the edge it crosses.

## Files

| file | role |
| --- | --- |
| `tests/helpers/joiner-prediction-limits.ts` | the golden copy of the four limits, plus why it is a copy and not an import |
| `tests/unit/identity-joiner-pass.test.ts` | exact-equality on both planner return sites + the four window-edge cases |
| `tests/unit/identity-joiner-run.test.ts` | exact-equality on the persisted row, on a refused row and a clean one, with a positive control |

## Decisions

- **Golden prose over a regex.** The objection to a golden string is that it
  breaks when the text changes. That is the feature here: these sentences are
  the whole of what stops "would create N accounts" being read as a promise,
  and softening one should be something a reviewer sees rather than something
  a `.some(/topic/)` waves through.
- **A positive control beside the equality.** `toEqual` is evidence only if it
  can fail, so the run suite applies two of the transforms it exists to catch —
  per-string truncation and reversal — to the fixture itself and asserts the
  matcher rejects both. A green row above therefore means the row matched, not
  that the matcher waves arrays through.
- **Both planner return sites, separately.** `planJoinerPass` returns from
  `refuse(...)` and from its tail, each spelling `predictionLimits` itself, so
  one can lose them while the other keeps them. The refusal case is asserted
  over five refusals and the clean case over a configured tenant.
- **The dispatcher needed nothing.** All ten scoping mutations — the provider
  predicate, `isEnabled`, the `(tenant, provider)` dedupe, the payload's
  provider, the starter query's `tenantId`, a date predicate pushed into that
  query, and the provider scope on each of the two directory reads — already
  reddened a test. Acceptance 2's tenant half was met; only its date half was
  not.
