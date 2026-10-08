# 2026-10-08 — The deterministic reconciliation engine (Step 3b)

**Commit:** `add789c5e feat(identity): the deterministic reconciliation engine and its precision ratchet (Step 3b)`

## Design

A pure function from (accounts, roster, directory, confirmed aliases, config, `now`)
to exactly one `Resolution` per account. Five outcomes, four strong signals, three
vetoes, and a precision gate over the Step 3a corpus.

The whole design answers one question: *what stops a false `LINKED`?*

The obvious answer — weight every signal, sum, link above a threshold — cannot hold.
Enough weak evidence eventually crosses any line you pick: two initials, a shared
department and a similar surname will do it, and the line has to move every time a
signal is added. Worse, the line is a number in a diff, so loosening it looks like
tuning.

So strength is a KIND, not a score:

```
SIGNAL_STRENGTH: Readonly<Record<SignalKind, 'STRONG' | 'SUPPORTING'>>
  CONFIRMED_ALIAS   STRONG        EMAIL_UNTAGGED        SUPPORTING
  EMPLOYEE_NUMBER   STRONG        STALE_DIRECTORY_LINK  SUPPORTING
  EMAIL_EXACT       STRONG        NAME_EXACT            SUPPORTING  ← Step 4a
  DIRECTORY_BRIDGE  STRONG        NAME_TRANSLIT         SUPPORTING  ← Step 4a
                                  NAME_INITIAL          SUPPORTING  ← Step 4a
                                  USERNAME_CONVENTION   SUPPORTING  ← Step 4a
                                  SIMILARITY            SUPPORTING  ← Step 4a
```

`LINKED` requires one STRONG signal, held by exactly one candidate, unvetoed, on a
record that is not terminated. Scores still exist — they order the candidate list a
reviewer sees — but nothing compares a score against a link threshold.

The table is keyed on a closed union, so a kind added without a classification is a
compile error rather than an `undefined` that `=== 'STRONG'` quietly reports as false.

### The part that matters for Step 4a

4a adds the fuzzy matching — naming conventions, transliteration, similarity. That is
exactly what a precision gate is afraid of, so the extension point is typed to make
the dangerous case unrepresentable:

```ts
export type CandidateScorer = (
    account: CanonicalAccount,
    candidate: RosterEmployee,
    context: ScorerContext
) => readonly SupportingSignal[];     // ← kind: SupportingSignalKind
```

A 4a scorer cannot emit a strong signal. Not by convention, by `tsc`. The five 4a
kinds are declared in this step, unused, so the exhaustive "no combination links"
test covers them *before they have an implementation* — all 127 non-empty subsets of
the seven supporting kinds, each at score 10,000, asserted never to link, with one
and two candidates.

The scorer is also called once per (account, candidate) pair that blocking produced,
never over the cross product, so 4a cannot reintroduce the O(n²) the blocking index
exists to avoid.

### Precision gates, recall is printed

Measured on the corpus: **27 cases, 3 auto-links, 0 false, 3/3 of the links the
corpus expects, 14/27 exact outcomes.**

The 13 misses all need name matching and resolve to `UNMATCHED` today. Gating recall
would be actively harmful: the honest response to a tightened precision rule is
*fewer* links, and a recall gate would score that as a regression — so the test suite
itself would push the engine back toward linking on weaker evidence.

But a precision-only ratchet is passed trivially by an engine that links nothing, so
the gate has a floor as well as a ceiling: the three expected links are asserted
individually. That second assertion is the one doing the work.

### No I/O, no clock

No Prisma import anywhere in the transitive graph (asserted by walking import
specifiers — not raw text, because this module's own docblock cites
`db/concurrency-limits.ts` and a mention of a path is not a dependency on it). `now`
is a parameter: a reconciliation re-run over an unchanged snapshot must produce the
same answer, and "was this link fresh?" is a question about the snapshot, so the
caller answers it and passes `linkFresh` in.

## Files

| File | Role |
| --- | --- |
| `src/lib/identity/reconcile/engine.ts` | The engine. Blocking index, signals, vetoes, the re-keyed rule, the decision ladder. |
| `tests/unit/identity-reconcile-precision.test.ts` | The acceptance test. 34 assertions across 12 groups — one per hardening-checklist item, plus the duplicate-roster refusal and the design document's own NON_PERSON examples. |
| `docs/legacy-access-recertification-design.md` | Banner corrected (the Roadmap heading no longer means "unbuilt"); new Current-state subsection for the engine. |
| `docs/legacy-access-recertification-phases.md` | Status table made true — all 8 rows with a PR were stale. |
| `CLAUDE.md` | How invariant 2 is now enforced, and the three rules that are easy to undo. |

## Decisions

- **`EMAIL_EXACT` is `emailKey` byte-equality, against the step brief.** The brief says
  "EMAIL_EXACT, with domain equivalence". The corpus disagrees and explains why:
  `da-01` expects `SUGGESTED` for a `googlemail.com`/`gmail.com` pair because
  "emailKey is what the JML chain joins on, byte for byte". A link made on a folded
  domain is a link the leaver cannot act on. So domain equivalence and `+tag` removal
  became `EMAIL_UNTAGGED`, a supporting signal. Deviation recorded in the PR, per
  CLAUDE.md's rule that the design wins and the PR says so.

- **An employee number comes from a login only when the login is all digits.**
  `normaliseEmployeeNumber`'s regex allows up to eight leading letters, so
  `normaliseEmployeeNumber('kpatel3')` returns `'3'`. Left unguarded, a name with a
  counter would pose as the strongest signal in the system; the corpus has no employee
  numbered `3`, so the corpus alone would not have caught it. The all-digits test is
  the same distinction `normaliseUsername` already draws when it refuses to split a
  stem containing no non-digit.

- **A self-contradicting roster is refused, not resolved.** Found by writing the
  order-independence test, not by review: the corpus's per-case `hr` slices carry
  `e-100` three ways and `e-104` two, so concatenating them produced a roster where
  `byId` kept whichever row arrived last — and the answers for `tlee` and `tlee2`
  swapped with the shuffle. `DuplicateRosterIdError` refuses the whole run rather than
  the row, because a roster that contradicts itself about one person gives no reason to
  trust what it says about the others. An exactly-repeated row is tolerated, with a
  control asserting so, since the check is about contradiction rather than duplication.

- **`admin` is in `DEFAULT_SERVICE_TOKENS` because the design says so.** It was left
  out of the first draft on the reasoning that it reads like it could be a name. The
  design document names it explicitly alongside `svc_backup` and `batch_user`, and it
  is not a surname in any locale this ships to. The corpus does not cover it, so the
  omission was invisible until the design was re-read — there is now a standing test
  for all three named examples plus the `bsvcic` / "Bea Svcic" control.

- **NON_PERSON needs a service token AND the absence of a human name.** A login-only
  rule classifies Bea Svcic as a robot, because `bsvcic` contains `svc`. Tokens are
  compared whole, never as substrings, which is what the corpus's `sa-03` exists to
  check — it is labelled there as "the control for sa-01".

- **Ties are `AMBIGUOUS`, and the comparator is a total order.** Two candidates both
  proving a strong signal is a contradiction in the data, not a close call; picking the
  higher score is how one person gets another's access. The candidate sort breaks ties
  on `employeeId` rather than leaving equal scores in arrival order — and the
  order-independence test made the same mistake one level up, sorting resolutions by
  `accountKey` when four corpus cases share the key `jjones`. It failed while the
  engine was right.

- **The comparison budget is a multiple of `accounts + roster`, not a constant.**
  `COMPARISON_BUDGET_MULTIPLE = 8`, stated rather than inherited, for the reason
  `db/concurrency-limits.ts` gives about its own numbers. Bounding against something
  the input *has* means the budget cannot be satisfied by a small input or blown by a
  large legitimate one. Measured: 2000 comparisons for 2000 × 2000, against a budget of
  32000 and a cross product of 4,000,000. Counted, never timed — a wall-clock
  assertion measures the runner.

- **What the mutation proofs establish, and what they bound.** Three mutations, each
  restored byte-identical: promoting `EMAIL_UNTAGGED` to `STRONG` → 2 false links;
  disabling the re-keyed rule → 1 false link, onto the terminated record, which is the
  worst direction because the account then looks handled and is never disabled; making
  a strong-signal tie pick a winner → **0 false links**, caught only by the dedicated
  tie tests. That third result is the useful one: the corpus contains no strong-signal
  tie, so the precision ratchet is blind to that regression. The corpus is not a
  complete oracle, and the hand-written cases are not decoration.

## What this step did not do

The engine has no input. There is no MCP client (1b) and no snapshot model (2a), so the
only caller of `reconcile` today is its own test. Building the matcher ahead of the pipe
was deliberate — it is the part where a mistake grants access, so it was worth proving
against a labelled corpus before there was live data to get wrong — but nothing here
should be read as "legacy reconciliation works".
