# 2026-09-20 — the `.sql` gate opened, and it measured +6 rather than +15 (#2644)

**Refs:** #2644 (the issue and the owner decision), #2643 (`sqlCodeOf`), #2679
(the language split), #2246 (the Class A ratchet). Predecessors:
`docs/implementation-notes/2026-09-19-sql-exclusion-delta-measurement.md`,
`docs/implementation-notes/2026-09-20-sql-seam-language-split.md`.

`.sql` is now in `LEXABLE_EXTENSIONS`. `RAW_ASSERTING_FILE_BASELINE` is
**344**, re-seated from 338. **No `.sql` seam was converted in this diff** —
that is the campaign's next batch and belongs in its own.

## The headline: the decision said 353, the guard says 344

The owner decision of 2026-09-20 reads "re-seat `RAW_ASSERTING_FILE_BASELINE`
338 → 353" and, in the same comment, "re-derive the number by RUNNING the guard
rather than by arithmetic — 353 is the prediction, not the measurement". Run,
it is **344**: +6, not +15.

**The 9 is not drift and is not a second population. It is #2679, which merged
at 09:18 UTC the same morning, two hours before the decision was written.**

The measurement offered three states:

| state | rule | count then | count now |
| --- | --- | ---: | ---: |
| 1 — base | `.sql` not counted | 376 | 338 |
| 2 — counted, untaught | `codeOf` accepted as a mask on a `.sql` read | 382 (+6) | **344 (+6)** |
| 3 — counted, taught | only a SQL-aware mask accepted on a `.sql` read | 391 (+15) | **344 (+6)** |

**States 2 and 3 are now the same state, and #2679 is what merged them.** The
+15 row existed for one reason: at measurement time all 46 masked `.sql` sites
spelled `codeOf`, the TypeScript lexer, which blanks nothing in a migration
while reading as masked — so a rule that accepted only a SQL-aware mask
reclassified all twelve files from masked to raw. #2679 converted those twelve
to a separately named `sqlCodeOf` seam. They now satisfy *both* rules, so
neither state credits a mask that is not there and both measure 344.

### The owner's condition is the one that held, not the arithmetic

> Nobody is credited for a mask they do not have.

Measured on this tree, the 122 previously-invisible `.sql` sites split
**76 raw across 29 files** and **46 masked across 12 files**, with **0 files in
both buckets**. The twelve masked ones are exactly #2679's twelve, and their
mask is real — #2679 mutation-proved it 12/12 by commenting out the DDL and
reddening twelve named tests. The six files that enter the population are
exactly the files whose migration reads carry no mask at all:

| file | raw `.sql` sites |
| --- | ---: |
| `tests/guardrails/ai-gov-self-assessment-coverage.test.ts` | 2 |
| `tests/guardrails/audit-s1-residual-and-mitigated.test.ts` | 2 |
| `tests/guardrails/audit-s3-evidence-mgmt.test.ts` | 1 |
| `tests/guardrails/cve-integration-coverage.test.ts` | 4 |
| `tests/guardrails/risk-quantitative-analytics.test.ts` | 2 |
| `tests/guards/rq3-6-loss-event-register.test.ts` | 7 |

The other 23 of the 29 raw-`.sql` files were already in the 338 for their
TypeScript reads, so they cost the ceiling nothing. That six are exactly the
six the measurement's §5a predicted is the check that the two passes agree.

### 353 is not reachable by any defensible change, and that was measured too

The obvious way to "get back to +15" would be to stop crediting `sqlCodeOf`.
Tried, as a throwaway experiment: unregistering `['sqlCodeOf', sqlCodeOf]` from
`SOURCE_BLOCKS_MASKERS` does **not** produce 353. It leaves the count at
**344** and drops those 46 sites out of the whole-file population entirely,
into `not-a-file-read` (5432 → 5490) and out of `path-not-constant`
(917 → 905, measured before the `a443e550f` merge) — i.e. into the bucket nothing caps, which is the evasion route the
ratchets exist to close. `tests/helpers/assertion-reach.ts` was restored from a
byte-for-byte backup and the restore verified by `md5sum` + `diff`, not by eye.

## Denominators, and what did not move

Whole-tree walk, 2441 test files, 12467 `toMatch`/`toContain` sites (measured
on the tree with `origin/main` at `a443e550f` merged in; the shut/open pair
below was taken on the same tree, one run each, so the two columns differ only
by the one-line extension change):

| | gate shut | gate open |
| --- | ---: | ---: |
| whole-file reads | 5938 | 5938 |
| raw sites | 3516 (336 negated) | 3592 (337 negated) |
| masked sites | 1955 | 2001 |
| unlexable sites | 467 | 345 |
| `.sql` in the unlexable histogram | 122 | — |
| **`rawFiles`** | **338** | **344** |

122 = 76 + 46 exactly, so no `.sql` site went missing across the move.

**The other six zero-allowance constants were re-derived by running their
guards, not by trusting the prediction.** All six are unchanged:
`AMBIGUOUS_NEEDLE_BASELINE` 1333, `HIGHLY_AMBIGUOUS_NEEDLE_BASELINE` 226,
`UNANALYSABLE_READ_BASELINE` 1454, `UNBOUNDED_INTERIOR_SPAN_BASELINE` 147,
`INTERIOR_SPAN_BASELINE` 332, `UNANALYSABLE_TOMATCH_BASELINE` 57. Each is
two-sided — a `>` ceiling plus an `assertRatchetSlack` sentinel at
`DRIFT_ALLOWANCE = 0` — so green in both suites means the live count equals the
baseline exactly rather than merely sitting under it. `subjectSkips` is
byte-identical across the change, which is the mechanism: `LEXABLE_EXTENSIONS`
has no importer outside the Class A pair, and Classes C and D contain no
extension filter of any kind.

## Mutation proof — four, each RED, each restored and verified

Green proves nothing here: every one of these tests passes on a tree where the
gate never opened. Each mutation is at the **call site**, and each restore was
verified with `md5sum` + `diff` against a backup taken first.

1. **Mask a newly-counted seam.** `tests/guards/rq3-6-loss-event-register.test.ts`
   — wrap its migration read in `sqlCodeOf`. RED:
   `every listed file still asserts on raw source (no stale entries)`, naming
   that file and printing "Set RAW_ASSERTING_FILE_BASELINE to 343"; plus
   `the comparison itself can fail, in both directions`. This is what proves
   the file is in the list **because of its `.sql` read** and not for some
   other reason.
2. **Close the gate again.** Remove `'.sql'` from `LEXABLE_EXTENSIONS`. RED on
   four, naming all six newcomers, including both detector proofs added here —
   `COUNTS an unmasked migration read — the .sql gate is open` and
   `a migration masked with sqlCodeOf is masked — and with codeOf it still
   reads as masked`. A RED certifies an anchor; a GREEN certifies nothing, and
   these two were written to be certified.
3. **Close the gate, against the live-tree assertion.** RED on
   `the .sql gate is open over the LIVE tree, not only over a fixture`.
4. **The regression the cap exists to catch.** Un-mask
   `tests/guardrails/framework-delta-coverage.test.ts`'s `readSql` seam — the
   realistic edit, a `sqlCodeOf` someone deletes. RED on
   `no test file outside the 344 listed ones asserts on raw source`:
   `current 345 / ceiling 344`, naming the file, its 3 raw sites, the line, and
   the migration it reads. **Before this diff that same edit moved nothing**,
   because the read was excluded by extension. That is the whole value of
   opening the gate, stated as a failing test rather than as a claim.

### One assertion was caught being vacuous, which is worth recording

The first draft of the rewritten exclusion proof kept
`expect(r.unlexableByExtension['.sql']).toBeUndefined()` inside the fixture
test, whose report comes from a single synthetic `.yml` file — where `.sql`
could never appear whatever the extension set said. Mutation 2 did **not**
redden it. The claim moved onto the live report, where mutation 3 does redden
it. A synthetic sitting next to a real mutation is not evidence that the real
mutation was seen.

## What changed, and what deliberately did not

- `tests/helpers/raw-source-assertions.ts` — `'.sql'` added; the two docblocks
  that described the exclusion rewritten. The set's meaning is now "languages
  **some** registered masker lexes", not "languages `codeOf` lexes", and that
  distinction is now written down beside it.
- `tests/guardrails/raw-source-assertion-ratchet.test.ts` — the constant, the
  History entry (the only UPWARD one; the header rule was amended to say so and
  to require a widening to name the files it admits), the `FIX_ADVICE` prose,
  and the detector proofs.
- `tests/guardrails/raw-source-asserting-files.json` — +6 lines, 0 deletions.
- `tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts` — one history
  note annotated. Its parenthetical "`.sql` is excluded from Class A by
  extension" was true on its own diff and is not now. It is annotated rather
  than rewritten: deleting a measurement because the world moved is how a
  history entry stops being evidence.

**Not done, on purpose:** no `.sql` seam converted. The point of entering
uncredited is that the 29 raw files have somewhere to go, and the way this
count comes back down is evidence — a real masker at a real seam — not another
re-seat.

**One open caveat inherited from the measurement, unchanged here.** The
analyser records "a masker ran", not "a masker that lexes this language ran".
`codeOf` on a `.sql` read would still count as masked. Nothing in the tree does
that today (#2679 removed the last twelve), and the ordering that kept it safe
— convert the seams, *then* widen the extension set — is now written into
`FIX_ADVICE` and asserted, with its known gap, in the detector proof. Teaching
the analyser to match masker to language is the real fix and is not this diff.
