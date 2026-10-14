# 2026-10-14 — a second, independent signal for single-evidence rows (#3516)

**PR:** #3552 · **Issue:** #3516 (reviewer-ergonomics half; the held-out half
is #3551 / `2026-10-14-deterministic-held-out-set.md`)

## The measurement that set the scope

Over the Step 3a corpus with 4a extensions wired, of the **24 residue rows** a
reviewer actually sees:

| rows | evidence they carry |
| --- | --- |
| 7 | `NAME_TRANSLIT` **alone** |
| 5 | `SIMILARITY` **alone** |

Twelve of twenty-four hand a person one fact and no way to corroborate it
without opening the roster themselves.

**And a second signal from the existing vocabulary would not have helped.**
Every other supporting kind is about a name, an address or a directory link, so
a second one drawn from those restates the first rather than confirming it.
`department` is the cheapest genuinely independent fact the engine already
holds on both sides (`CanonicalAccount.department`, `RosterEmployee.department`)
— independent because a department does not depend on how a name is spelled.

## What it deliberately cannot do

This is the larger half of the design. The kind annotates; it never decides.

| property | how it is held, not merely intended |
| --- | --- |
| changes **no outcome** | `SIGNAL_STRENGTH.DEPARTMENT_MATCH = 'SUPPORTING'`, and `identity-reconcile-precision` enumerates the whole supporting union at score 10,000. Its assertion is `2 ** SUPPORTING_SIGNAL_KINDS.length - 1`, **derived rather than hardcoded**, so adding the kind extended the proof from 127 subsets to 255 with no edit |
| cannot widen a shortlist | it is a **scorer**. Scorers run per candidate the blocker already produced and cannot create one. As a blocker it would make every member of Finance a candidate for every other |
| cannot break a tie alone | two candidates in the same department both receive it — asserted on candidate scores directly |
| **absence is not a match** | two blank departments are not colleagues. Scoring them as such would corroborate every weak name match in a source system that leaves the field empty, which is most of them |
| does not move the bulk bound | weight **40**, below `SCORER_WEIGHTS.CONVENTION`, which `legacy-reviewer-actions` uses to bound bulk confirmation. At or above it, who qualifies for bulk would change silently and this PR would be doing two things |

## The corpus cannot exercise it, which is stated rather than left implicit

`department:` occurs **zero** times as a value in `corpus.ts`. The only two
`department` hits are the **slice type declarations** (`readonly department?:
string | null;`) on the corpus's own local types — which is the cleanest way to
say it: the types say a source system *can* supply it, the fixtures say they
currently *don't*.

**The first probe of this returned 0 cases**, so its zeros meant nothing; a
27-case control was added before the zero was believed.

Adding the field to existing cases is **not** a cosmetic edit — at +40 it can
separate two candidates that currently tie, turning an `AMBIGUOUS` into a
`SUGGESTED`. So the corpus was left alone and the claim is demonstrated end to
end through the real engine instead:

```
without departments  ->  ['NAME_TRANSLIT']
with departments     ->  ['DEPARTMENT_MATCH', 'NAME_TRANSLIT']    same outcome
```

Real reviewer benefit therefore depends on source systems supplying the field.
That is a limitation of today's fixtures, not of the signal, and it is recorded
here so nobody reads the merged PR as "12 rows improved".

## Mutation proofs

| mutation | result |
| --- | --- |
| reclassify the kind `STRONG` | **3 tests fail**, incl. the exhaustive subset proof |
| raise the weight above the bulk bound | 1 fails |
| let absence count as a match | **9 fail** |

## One thing `tsc` caught, which is the mechanism working

`SCORE` is `Readonly<Record<SignalKind, number>>` — exhaustive on purpose — so a
new kind without an entry **fails to compile**. It did. The entry is added at
the bottom of that scale and documented as *never emitted by this module*: the
scorer supplies its own weight, and an unused constant that looks live is a
trap for the next reader.

## Files

| File | Change |
| --- | --- |
| `src/lib/identity/reconcile/engine.ts` | `\| 'DEPARTMENT_MATCH'` on `SupportingSignalKind`; `SIGNAL_STRENGTH` and `SCORE` entries |
| `src/lib/identity/reconcile/scorers.ts` | `SCORER_WEIGHTS.DEPARTMENT: 40`, `makeDepartmentScorer()`, `normaliseOrgUnit()`, wired last in `step4aExtensions` |
| `tests/unit/identity-conventions-similarity.test.ts` | 8 tests, incl. the end-to-end engine demonstration and the tie-preservation case |

## The verification claim, and what was wrong with it at first

132 of 134 suites touching the signal vocabulary or the engine — 3368 tests. The
2 failures were `PrismaClientValidationError: Unknown argument
parentExecutionId` at `workflow-runs.ts:1044`: #3539's field against a **stale
generated client**, in suites that create a `WorkflowRun` and touch no identity
signal.

That diagnosis was later **confirmed rather than left as an assertion**. Once no
jest or prisma process was live (verified with a positive control — an earlier
check had counted my own shell), regenerating took the client from 43 to 94
occurrences of the field and `tsc --noEmit` went from 9 errors to **zero**.
`main`'s schema carries `parentExecutionId` on *both* `AutomationExecution` and
`WorkflowRun`, so regenerating from main costs no peer anything.
