# 2026-10-08 — Naming conventions and similarity (Step 4a)

**Commit:** `feat(identity): naming conventions and name similarity, neither able to link (Step 4a)`

## Design

Three modules and one engine change.

```
conventions.ts   grammar + parser + generator + proposer
similarity.ts    Jaro-Winkler + token-set ratio, in-house
scorers.ts       the four extensions: 2 scorers, 2 blockers
engine.ts        + CandidateBlocker, the extension point 3b was missing
```

### What this step is allowed to do

Move accounts from `UNMATCHED` to `SUGGESTED`. Nothing else. Step 3b made that a
type error rather than a convention — `CandidateScorer` returns `SupportingSignal`,
whose `kind` is narrowed to the non-strong union — and it proved the property
exhaustively over all 127 subsets of the supporting kinds, at a score of 10,000
each, *before any of them had an implementation*. This step supplies the
implementations and that test keeps holding.

Measured on the Step 3a corpus, engine + both scorers + both blockers:

```
cases              27
false links         0    (GATED)
expected links hit  3/3  (GATED)
SUGGESTED          18    (was 3 with the engine alone)
```

### The gap this step found in Step 3b

Step 3b shipped a scoring extension point and no blocking one, and that made the
scoring one unreachable for the case 4a exists to serve. An account with a name and
nothing else blocks to NOBODY under the built-in keys — email, employee number,
confirmed alias, directory bridge — so no scorer is ever called and the outcome is
`NO_CANDIDATES` whatever 4a would have scored.

Measured, not reasoned: a name-only account over a one-person roster reported
`comparisons=0, blockedAccounts=0, NO_CANDIDATES`.

So the engine gains `CandidateBlocker`. Blocking answers "which employees is this
account compared against?"; scoring answers "how well do these two match?". Two
rules keep it safe:

- a blocker may only ADD candidates, never remove one — a strong signal must not
  become unreachable because an extension did not recognise an account;
- every id a blocker returns is COUNTED in `metrics.comparisons`, so the stated
  comparison budget still binds and a blocker that returned the roster would blow
  the budget test rather than quietly undo the index.

## Files

| File | Role |
| --- | --- |
| `src/lib/identity/reconcile/conventions.ts` | The grammar (12 tokens + `{n?}`), its parser, the username generator, the collision-aware matcher, and the proposer. |
| `src/lib/identity/reconcile/similarity.ts` | Jaro, Jaro-Winkler, token-set ratio, and a combined scorer that records the romanisation scheme when one helped. |
| `src/lib/identity/reconcile/scorers.ts` | Two scorers, two blockers, and `step4aExtensions` as the one assembly point. |
| `src/lib/identity/reconcile/engine.ts` | `CandidateBlocker` added; blockers called after the built-in keys. |
| `src/app-layer/usecases/legacy-username-convention.ts` | Adoption: `assertCanAdmin`, versioned, audited, validated. |

## Decisions

- **A convention is declared, never inferred.** The tempting design fits the
  template that best explains the snapshot. That is circular: the accounts that fit
  become evidence for the rule that explains them. Worse, the population being
  fitted contains the leavers and orphans this product exists to find, so a learned
  template is one that explains away the anomalies. `proposeConventions` MEASURES
  and returns a list with no "best"; a human adopts one.

- **A collision is an equal score, not a tie-break.** When a template generates
  `jsmith` for both John and Jane Smith, the scorer emits the same signal at the
  same score to each, and the engine's existing tie rule yields `AMBIGUOUS`. No new
  engine branch. The alternative — having the scorer pick the earlier hire or the
  lower id — would be this module inventing a rule the convention does not contain,
  and it would reach a reviewer as a confident suggestion rather than as the real
  ambiguity.

- **A name that cannot be split generates nothing.** `fullName` is split only when
  it yields EXACTLY two tokens. A mononym generates nothing; a three-part name
  generates nothing. Guessing is how "Maria del Carmen Garcia" becomes `mdel` and
  matches the wrong person with a convention signal behind it. Two tokens is the
  only case with one reading.

- **Similarity is two measures, kept separate.** Jaro-Winkler fails on reordering
  (`Smith, John A.` vs `John Smith` scores under 0.7); token-set fails on typos. A
  blended score hides which one carried a suggestion from the reviewer looking at
  it. Both are implemented in-house so the published reference values can be
  pinned — `MARTHA`/`MARHTA` 0.961, `DWAYNE`/`DUANE` 0.84, `DIXON`/`DICKSONX`
  0.813 — because a dependency that changed its prefix scale in a patch release
  would move every threshold derived from it, silently, in a lockfile bump.

- **The family name is the blocking key, not the given name.** `john` matches
  everyone called John; a family name partitions the roster into groups small
  enough to compare. Same reasoning as the built-in email and employee-number keys:
  a key is useful when it is selective.

- **Adoption is a usecase with an audit row, not a settings field.** Getting a
  convention wrong produces no error — it produces plausible suggestions for the
  wrong people, which a reviewer may approve. So: `assertCanAdmin`, a version
  incremented on every change with the previous template kept, and an audit entry
  naming both templates. "Why was this account suggested to that person last
  month?" is answerable only if the rule's history survives.

- **Re-adopting the same template writes nothing.** No version bump, no audit row.
  Versions that advance without a change make the history harder to read, and an
  audit trail of non-events trains people to skip it.

## What the mutation proofs found

Four mutations against the suite, each restored byte-identical:

| Mutation | Failing assertions |
| --- | --- |
| blockers removed (the pre-extension state) | 11 |
| the convention scorer breaks the collision tie | 2 |
| a blocker clears candidates instead of only adding | 1 (in Step 3b's own suite) |
| the similarity floor set to 0 | **0** |

The last row was the finding. The floor — below which a similarity is noise and is
not emitted — had no test, so moving it broke nothing. It decides what a human is
asked to look at, and it now has four assertions including one that proves the
threshold discriminates between the pair above it and the pair below.

The same technique caught a weaker shape in the table test: it originally allowed
`UNMATCHED` among the acceptable outcomes, and before the blocking extension
existed every case in it returned `NO_CANDIDATES` — so the whole table passed while
proving nothing. It now requires each case to reach a scorer.

## What this step did not do

The engine still has no input: the MCP client landed in Step 1b and nothing calls
it, and snapshots are Step 2a. The convention usecase has no route — there is a
usecase and no caller, deliberately, because the review queue that would expose it
is Step 4b.
