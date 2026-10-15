# 2026-10-15 — three findings from writing one positive control (#3550, #3559, #3560)

**PRs:** #3561 (#3550), #3562 (#3559) · **Open question:** #3560

One task — settle whether a zero-evidence tie should be `AMBIGUOUS` or
`UNMATCHED` — and the *positive control* for its gate turned up two things
nobody was looking for. The method is the transferable part, so it is recorded
first.

## The method

The decision itself needed a gate. A gate needs a **positive control**: an
assertion that the outcome under test is *reachable*, so that a change which
merely deletes the outcome cannot pass. I tried to draw that control from the
corpus. It did not work, twice, for two different reasons — and each failure
was a finding:

| attempt | what happened | finding |
| --- | --- | --- |
| use `db-02`, the corpus's one `AMBIGUOUS` case | returns `SUGGESTED` under production wiring | **#3560** |
| construct a two-candidate tie by hand | returns `NO_CANDIDATES` | **#3559** |

Neither failure looked like a finding at the time. Both looked like my harness
being wrong.

## 1. The decision (#3550)

`in-01` — `'J Jones'` against Jamie and Jordan Jones — expected `AMBIGUOUS`
since the corpus was written; the engine had always returned `UNMATCHED`. The
held-out set reproduced the same disagreement on two unseen cases.

**The fixture's own prose could not settle it.** Its rule was *"the engine must
refuse to pick"* — and both answers refuse to pick.

**Owner decision: `UNMATCHED`.** And the premise I had put in the issue was
wrong: I framed it as *"does the reviewer see two names, or none?"*.
`listReconciliationQueue` includes `UNMATCHED` in the queue and selects
`candidatesJson` unconditionally; the review page renders candidates on
`candidates.length > 0`, not on outcome. **Both names appear either way.**
Reading the UI rather than asserting about it is what made the question
answerable — and what demoted it from a product change to a vocabulary choice.

Gated as an invariant derived over both fixture sets, **not** as fixture
equality: the held-out suite deliberately reports agreement rather than gating
it, because gating agreement makes the first honest disagreement a red build
and editing the fixture the quickest way back to green.

## 2. The proof that ran over nothing (#3559)

`RQ-3b — supporting signals cannot link, exhaustively` is the proof the whole
supporting-signal design rests on.

```
subsets=127  evaluated=254  TOTAL_CANDIDATES=0  SCORER_CALLS=0
```

The engine creates no candidate for a name-only account; candidates come from a
strong-signal path or a `config.blockers` entry, and **scorers run per existing
candidate**. The block passed only `scorers`, so the scorer was never invoked
once.

**The floor meant to prevent exactly this counted the wrong thing.** Its
comment — *"The denominator, so an empty selection cannot pass as a clean
sweep"* — has the right intent, and `evaluated` counts `reconcile` **calls**,
which happen whether or not a candidate exists. It would read 254 against a
stub engine.

The number that matters:

| mutation | OLD test | NEW test |
| --- | --- | --- |
| **engine sums supporting scores and thresholds** | **37 passed — blind** | **1 failed — caught** |
| promote a supporting kind to `STRONG` | 2 failed | 2 failed |

The second row is why the block was not *wholly* inert: that mutation was
already caught by the sibling `STRONG_SIGNAL_KINDS` and `strengthOf`
assertions. The one assertion enumerating 127 subsets contributed nothing.

**The claim is true.** With a blocker, 7 kinds at 10,000 each gives score 70,000
and outcome `SUGGESTED`. The engine reaches `LINKED` only from an unvetoed
STRONG signal — structurally, not by threshold. No production defect; a test
defect.

#3552 cited this proof as load-bearing in its body and its own note. Corrected
in both before this landed, rather than left to be squashed into `main`.

## 3. `AMBIGUOUS` is unreachable in practice (#3560, open)

```
45 cases (CORPUS 30 + HELD_OUT 15)
Step 3b alone : LINKED 8  UNMATCHED 26  SUGGESTED 7   NON_PERSON 3  AMBIGUOUS 1
with 4a wired : LINKED 8  UNMATCHED 10  SUGGESTED 24  NON_PERSON 3  AMBIGUOUS 0
```

`db-02` — one account in two directory connections, both links **fresh**,
pointing at two **different** employees — is the shape the outcome exists for.
At Step 3b both candidates tie at 250 and it is `AMBIGUOUS`. With 4a wired as
production wires it, `SIMILARITY` adds 140 to one side (390 vs 250) and it
becomes `SUGGESTED e-100`: *"probably Jamie Jones"*.

**What is not wrong:** the margin is 140, below `BULK_MIN_MARGIN` (220), so the
row is individually reviewable and **not** bulk-confirmable. The bound is a
margin rather than an absolute score precisely so one extra signal cannot
qualify a row, and it does its job. Both candidates stay visible.

Left as a question rather than a change: `AMBIGUOUS` currently means *the top
two tie exactly*, and with any similarity scorer wired an exact tie needs two
candidates indistinguishable to every scorer. Making it margin-based — reusing
the bound bulk already uses — would move an unknown number of today's
`SUGGESTED` rows, which is the thing to measure before deciding.

## What to take from this

- **A positive control is not ceremony.** Both findings came from insisting the
  outcome under test be demonstrably reachable. A gate without one can pass by
  the subject having disappeared.
- **A test that has always passed can have always been empty.** The tell was a
  *second* test, written independently, failing on the same input shape. Nothing
  in the first test's own history could have revealed it.
- **Count the thing that can reach zero.** `evaluated` was a denominator over
  the wrong quantity. The new floors are on scorer invocations and candidates,
  asserted at an exact figure rather than `> 0`, because a blocker nominating
  one id would halve both and still pass a positivity check.
- **Three of these needed the production wiring to be reproduced at all.** The
  precision suite measures Step 3b deliberately; `step4aExtensions` is what a
  tenant gets. A measurement under the wrong wiring answers a question nobody
  asked.
