# 2026-10-25 — The release waits for the merge queue

## Design

semantic-release pushes its `chore(release)` commit straight to `main` through
the ruleset's bypass, a median 1.3 minutes after each merge. Every merge-queue
candidate in flight was built on `main` as it was, so that push invalidates them
all and the queue rebuilds them. That was the largest single source of queue
churn.

Measured over 18–25 Oct 2026:

| | |
| --- | --- |
| queue runs | 397 |
| cancelled | 171 (43%) |
| cancelled by a release push | 121 of 171 (71%) |
| merged PRs needing more than one queue run | 104 of 194 |
| median queue wait, built once / rebuilt | 16 min / 61 min |

The release workflow now asks the queue first:

```
push to main ──► Wait for the merge queue ──► entries other than this push's?
                                              ├─ yes → release=false, semantic-release skipped
                                              └─ no  → release=true,  semantic-release runs
schedule (02:41 UTC daily) / workflow_dispatch ──► release=true regardless
```

The merge that empties the queue releases everything since the last version in
one release. The daily run bounds how long a release can be held.

## Files

| File | Role |
| --- | --- |
| `scripts/lib/release-queue-gate.js` | The pure rule: `decideRelease`, `prNumberOfCommit` |
| `scripts/release-queue-gate.mjs` | Reads the queue over GraphQL, writes `release=` to `$GITHUB_OUTPUT` |
| `.github/workflows/release.yml` | `schedule` + `workflow_dispatch` triggers; the gate step; the `if:` on semantic-release |
| `tests/unit/release-queue-gate.test.ts` | The rule, the script as a real process against a local endpoint, the workflow wiring |
| `docs/change-management-policy.md`, `CLAUDE.md` | No longer say "every push to main" |

## Decisions

- **The entries this push is merging do not count.** They can still be listed
  for a moment after the push lands, and they will never build again. Counting
  them would hold the very release that should go out. Each squash commit names
  its PR as the last `(#N)` of its subject, and the push payload lists every
  commit, so a push that merged a group of entries excludes all of them.
- **Unreadable fails open.** A queue that cannot be read releases, with a
  warning on the run. That is what every push did before the gate, so a broken
  read costs churn and never a missing release. In the workflow, only an
  explicit `release=false` skips semantic-release, so a gate that wrote nothing
  also releases.
- **An entry past the page counts as waiting**, through `totalCount`. The queue
  has held 15 entries at once; the page is 100.
- **The gate sits immediately before semantic-release**, after `npm ci`. That
  keeps the gap between reading an empty queue and pushing to the release's own
  run time, so a PR enqueued during the install is still seen. Held runs still
  spend the install; they did before too.
- **Daily, at 02:41 UTC.** 02:00–03:59 is the quietest stretch for merges in the
  measured week, and sub-daily crons have never fired in this repository (see
  `queue-candidate-sweep.yml`). The scheduled run releases even with a busy
  queue: on a day the queue never empties, one rebuild a day is the price of a
  version that is at most a day old.
- **Deploys are unaffected.** `ghcr-publish.yml` publishes on every push to
  `main` and nothing listens for tags or published releases, so a held release
  delays only the version number, the changelog and the coverage-floor raise.
