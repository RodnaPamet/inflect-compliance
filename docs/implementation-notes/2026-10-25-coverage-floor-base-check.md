# 2026-10-25 — The coverage floor measures a change against its base

## Design

`tests/guards/rendered-coverage-floor.test.ts` holds three populations
(rendered behavioural tests, E2E specs, registered high-risk primitives) to
floors in `tests/guards/coverage-floors.json`, which every release raises to
the live count. It had two checks:

1. **Hard floor:** each count at or above its floor. Kept.
2. **Slack sentinel:** each count no more than 8 / 4 / 3 above its floor.
   Replaced.

The sentinel came from the era when each PR raised the floors by hand, and it
forced them to. Once the release raised them (2026-10-24), it measured release
lag instead. A merge-queue candidate carries every entry ahead of it, so
several PRs that each added a test or two went over the slack together, and
the queue ejected all of them:

| 18–25 Oct 2026 | |
| --- | --- |
| queue candidates the sentinel failed | 14, across 9 PRs |
| queue removals that followed | 8 of the 43 removals that were not merges |
| of those failures, tests added / tests removed | 14 / 0 |

Check 2 now asks the question the sentinel stood in for, about the change
alone: **no count may be lower than at the change's base commit**, unless the
change lowers that floor in `coverage-floors.json` by at least as much.

```
base = first parent of the checked-out commit (CI) | merge-base with origin/main (local)
before = countCoverageAt(base)            live = countCoverage(working tree)
allowed = before − max(0, floorAtBase − floorNow)
fail when live < allowed
```

The first parent is the right base for every CI event. A pull request's
test-merge commit has the base branch first. A merge-queue candidate is one
squash commit on top of the candidates ahead of it, as its ref name says. A
push's first parent is the previous main. The Ratchets job now checks out two
commits so that parent is present, and the guard fails, saying so, if it is not.

## Files

| File | Role |
| --- | --- |
| `scripts/lib/coverage-floors.js` | `countCoverageAt` and `readFloorsAt`: the populations and floors of a commit, through git, counted by the same rules as the tree |
| `tests/guards/rendered-coverage-floor.test.ts` | The slack sentinel replaced by the base check; the hard floor's message names the reviewed way to remove a test |
| `.github/workflows/ci.yml` | Ratchets checks out with `fetch-depth: 2` |
| `tests/unit/coverage-floors-at-revision.test.ts` | The revision counts against small committed trees |
| `docs/verification-policy.md` | Describes the base check |

## Decisions

- **Stricter on removals, not looser.** The sentinel let a change delete
  tests whenever the count sat above its floor, up to the slack: with the
  floors 5 behind, deleting one rendered test passed both old checks. The base
  check refuses any net removal. Measured on a scratch worktree, with the floors
  5 behind and one test deleted, the hard floor passed (429 against 425) and the
  base check failed (429 against 430). With the floors 9 behind and one test
  added, the old guard failed (slack 10 > 8) and the new one passed.
- **A deliberate removal lowers the floor in the same change.** That was
  already the documented exception ("if a test was legitimately merged or
  renamed, account for it"), and lowering the stored floor is the one way to
  account for it that a reviewer sees as a line in the diff. The base check
  allows exactly the amount the floor came down.
- **Net counts, as before.** A change that renames a test, or deletes one and
  adds another, keeps its count and passes. The guard has always held
  populations, not names. A name manifest would make every rename a floors-file
  edit, which is the merge conflict that moving the floors into the release
  removed.
- **The working tree is what is counted.** That is what `countCoverage` always
  read, so an uncommitted deletion fails locally too. The base is read from git,
  so it is the committed state.
- **No base is a failure, never a pass.** Without its parent commit the guard
  cannot answer, and a guard that cannot answer must not report green.
