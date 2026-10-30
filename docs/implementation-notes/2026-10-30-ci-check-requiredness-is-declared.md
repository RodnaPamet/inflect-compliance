# 2026-10-30 — every CI job declares whether it is a required check

**Issue:** #4552

## The defect, twice

A gate gets built, merged, and never added to the required-status-check set. It
then runs on every pull request, reports red on a violation, and blocks nothing
— which is indistinguishable from working, because the check is PRESENT and its
failure is visible. Nobody reads the ruleset.

- **#3196** — `Ratchets` was not required, so a PR with failing architectural
  guards could merge.
- **#4552** — `Change class` (#4439) is built, running, and still not required,
  so the SIGNIFICANT-change rule advises rather than blocks. The gate exists
  because #4436 shipped a migration with neither a rollback plan nor a risk
  assessment while every check stayed green.

Two occurrences of one shape is the argument for catching the shape.

## What it does

`tests/guards/ci-check-requiredness-is-declared.test.ts` derives every job from
`ci.yml` and requires each to be classified `required: true|false` with a
reason, asserted by **exact set equality in both directions**.

| assertion | catches |
| --- | --- |
| the deriver finds >10 jobs and reads `name:` over the id | a regex that stopped matching, which would make everything below vacuous |
| derived ids equal the map's keys | a NEW gate nobody classified; a STALE entry for a deleted job |
| jobs marked required ↔ the six contexts | the map and the ruleset's names drifting apart |
| every `required: false` carries >40 chars of reason | `false` recording that somebody typed false rather than decided |
| `change-class` is false and names #4552 | the open gap being normalised into "that's just how it is" |

## The honest limit, stated in the file

**It cannot read GitHub's live ruleset.** A test has no credential for the
rulesets API, and gating CI on one would make every run depend on a token and a
network call. So it does not verify the six are required *today* — only
`gh api repos/.../rulesets/<id>` says that.

What it catches is the omission that produced both occurrences: the decision now
has to happen in the diff that adds the gate. When #4552's toggle lands,
flipping `change-class` to `required: true` forces `Change class` into
`REQUIRED_CONTEXTS` in the same edit, so the guard cannot be left half-updated.

## Decisions

- **Classification, not prescription.** `required: false` is a fine answer for
  13 of the 18 jobs. The value is that it is an answer. `flue` is recorded as
  "a candidate, not a deliberate exclusion" rather than given a confident
  reason it does not have — its jest population is disjoint from Test and
  Ratchets, so it is real coverage nobody has ruled on.

- **`test-summary` is the required `Test`, not `test`.** The sharded legs'
  context carries the matrix index (`Test (shard 1/7)`), which is not a stable
  name to require. The rollup is required precisely because it cannot report
  until every leg finishes.

- **Not folded into `merge-queue-trigger-coverage`.** That guard classifies the
  same jobs for a different question — which run in the merge queue — and
  `Change class` appears nowhere in it. Two weaknesses in it were found while
  checking and are filed rather than changed here, because a PR about
  requiredness should not quietly re-scope the queue's trigger invariant.

- **The reason threshold caught me first.** Five entries were written as
  one-liners and the >40-character assertion failed on three of them. Raising
  the threshold would have been the available move and the wrong one; the
  reasons were rewritten instead.

## Mutation proofs

| mutation | caught by |
| --- | --- |
| a new unclassified job added to `ci.yml` | `classifies exactly the jobs ci.yml declares` |
| a classified job renamed away (stale entry) | the same assertion, from the other direction |
| `change-class` silently flipped to required | `the jobs marked required are exactly the contexts` **and** `names the open gap` |

The second needed two attempts: the first script raised a `ValueError`, so the
mutation never applied and the suite's green said nothing. Verifying that the
mutation landed before reading the result is the half that makes a mutation
proof a proof.
