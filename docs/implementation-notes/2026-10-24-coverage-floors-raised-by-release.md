# 2026-10-24 — the release raises the coverage floors

**Commit:** see the pull request for `claude/coverage-floors-raise-on-release`.

## Design

`tests/guards/rendered-coverage-floor.test.ts` holds three populations at or
above a floor: rendered behavioural tests, E2E specs, and registered high-risk
primitives. A slack sentinel fails when a count runs more than its slack (8, 4,
3) above its floor, and the fix it demanded was to raise the floor constant in
the same pull request.

Every such raise edited the same line. Two PRs that each added a rendered test
either both raised the floor, and conflicted in the merge queue, or neither did,
and the queue's combined count tripped the sentinel. On 2026-10-24 this dropped
four PRs from the queue in one afternoon and needed hand-sequencing to recover.

Now nobody raises a floor by hand:

```
merge to main ─▶ release.yml ─▶ semantic-release
                                  prepare: changelog, npm (version)
                                           exec: node scripts/raise-coverage-floors.mjs
                                                 └─ tests/guards/coverage-floors.json ← max(floor, live count)
                                           git:  commits CHANGELOG, package*.json, coverage-floors.json
                                                 as `chore(release): x.y.z [skip ci]`
```

The floors moved from three constants in the guard to
`tests/guards/coverage-floors.json`. The guard and the script count through one
module, `scripts/lib/coverage-floors.js`, so the number the release writes is
the number the guard reads.

## Files

| File | Role |
|---|---|
| `scripts/lib/coverage-floors.js` | The three counts, the floors file, and `raisedFloors` (raise only) |
| `scripts/raise-coverage-floors.mjs` | The release step: raise, write if moved, never exit non-zero |
| `tests/guards/coverage-floors.json` | The floors, seeded at the counts measured on main (403 / 56 / 7) |
| `tests/guards/rendered-coverage-floor.test.ts` | Reads the floors file; checks the release config raises and carries it |
| `.releaserc.json` | `@semantic-release/exec` prepare step before `@semantic-release/git`; the floors file is a release asset |
| `tests/unit/raise-coverage-floors.test.ts` | Runs the script as a real Node process against temp trees |
| `docs/verification-policy.md` | Says the release locks the surplus in, not the PR |

## Decisions

- **A prepare step, not a separate workflow.** The release bot is the only
  identity with a bypass on main's ruleset, and it already pushes one commit
  per release. A second workflow pushing its own commit would need the same
  token and would race the release push. The floors ride in the release commit.
- **Only releases raise.** A merge with no release-worthy commit (`test:`,
  `docs:`, `chore:`) leaves the floors where they are until the next release.
  The slack covers that gap, and the sentinel's message now says so.
- **Never exits non-zero.** A failing prepare step stops the whole release.
  An unreadable floors file is a warning and the release carries on; the next
  release raises the floors.
- **Raise only.** A count below its floor is the guard's failure on the PR that
  caused it. Lowering a floor in the release would let a release spend exactly
  the regression the guard exists to catch.
- **Zero headroom after a release.** A floor sits at its live count right after
  each release, so a PR that legitimately removes a test lowers the matching
  number in `coverage-floors.json` and says why. That was already the
  documented exception; it is now one line in a JSON file.
- **CommonJS `.js` for the shared module.** Jest's CommonJS runtime cannot load
  an `.mjs` file, and the release step is an ES module; a CommonJS `.js` file
  loads in both as it is. Not `.cjs`: the Lint job's `react-hooks` plugin scope
  rejects it, as it does for `eslint-rules/`.
