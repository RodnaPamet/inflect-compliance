---
name: steward
description: How to take a pull request in this repository from opened to merged — when to open and merge, what "green" means here, how the merge queue behaves, and which bot comments need nothing. Read before acting on a CI, review or merge-queue event on a pull request you opened or drive.
---

# Stewarding a pull request in inflect-compliance

**This file applies rules that already exist; it makes none.** The authority is
`CLAUDE.md` — its "Working agreements" and "Failing tests" sections — plus the
docblocks of the workflows and guards named below. Where this file and one of
those disagree, the source wins and this file is the bug: fix it in the same
pull request that finds it.

## How far to go without asking

All of these are the owner's standing instructions in `CLAUDE.md`:

- **Open the pull request as soon as the work is pushed.** Do not wait to be
  asked.
- **Merge every green pull request you own.** Enable auto-merge, and the merge
  queue lands it. No per-PR confirmation is needed.
- **Do not hold a green pull request for the owner's `Sign-off:`**, not even a
  SIGNIFICANT one (a migration, security middleware, a dependency major bump).
  Write the rollback plan and the risk assessment into the description before
  it merges: the waiver covers the wait, not the analysis.
- **Never admin-merge and never merge past a red required check.** Drive the
  pull request to green, or say exactly what blocks it.
- **A red test is yours to explain even when `main` is red too.** Fix it here
  if the fix is small and on-scope. Otherwise open a focused fix PR, link it,
  and name the blocker in this pull request's description.

## What green means here

The required set is in the `SELECTING REQUIRED STATUS CHECKS` comment at the
top of `.github/workflows/ci.yml`: `Lint`, `Typecheck`, `Test` (the summary job,
not a shard), `Build`, `Security` and `Ratchets`. Read it there, not here.

- **Verify each check by NAME, freshly, on the current head.** A check that
  never ran looks the same as one that passed when you only count them.
- **Read the checks outside that set too.** `E2E` is deliberately not
  required, so a merge can go through with it red. `main-ci-failure-notice.yml`
  records the day that happened twice. The `ci.yml` comment records how a red
  guard merged because nobody read past the required set. A red check on your
  pull request is a failing test whether or not it is required: root-cause it,
  and if the pull request merged first, follow up with the fix.
- **On a merge-queue run, some jobs skip on purpose.** `E2E`, `Docker Build`,
  `Trivy Image Scan`, `Load Smoke`, `CodeQL SAST`, `E2E bundle` and
  `Scanner image` report `skipped` there, and branch protection counts a skip
  as a pass. That is the lean gate, not a missing run.
  `tests/guardrails/merge-queue-trigger-coverage.test.ts` holds which jobs skip.

## The merge queue

Once auto-merge is on and the required checks pass on the pull request, GitHub
adds it to the queue. The PR's timeline shows `added_to_merge_queue`. The queue
then builds a candidate, `gh-readonly-queue/main/pr-<N>-<base sha>`, runs CI
again on it, and lands the PR on `main` as one commit when the candidate
passes.

- **Do not push to a pull request while it is queued.** A push takes it out of
  the queue. Commit locally and push once it has merged. Push to it only if the
  new commit belongs to that pull request and you accept the re-queue.
- **A cancelled candidate is not a test failure.** The queue cancels and
  rebuilds candidates whenever an entry ahead of this one leaves the queue, and
  `queue-candidate-sweep.yml` cancels any candidate whose entry is gone. Each
  time, `queue-failure-attribution.yml` comments "Merge-queue candidate did not
  pass … CANCELLED" on the PR.
- **Before acting on a queue comment, read the timeline.** If no
  `removed_from_merge_queue` follows the last `added_to_merge_queue`, the PR is
  still queued, a new candidate is running or about to run, and there is
  nothing to do. The GitHub MCP tools do not return the timeline. The
  repository is public, so read it directly:

  ```bash
  curl -sS "https://api.github.com/repos/RodnaPamet/inflect-compliance/issues/<N>/timeline?per_page=100" \
    | python3 -c "import json,sys; [print(e.get('event'), e.get('created_at')) for e in json.load(sys.stdin)]"
  ```

- **Find the candidate runs** by listing CI runs for the `merge_group` event and
  keeping those whose `head_branch` starts with `gh-readonly-queue/main/pr-<N>-`.
  Read a candidate's jobs, not the PR's: the queue's result never shows on the
  PR's own head commit.
- **A candidate run produces no event on the PR.** The merge does
  (`pull_request.closed`), and so does the attribution comment, but nothing
  reports a candidate in progress or a queue that has stalled. Keep the
  safety-net check-in while a pull request is queued.
- **When it really was ejected,** the attribution comment names the failing
  candidate and says whether the failing suites overlap the PR's changed files.
  A failure the PR's own head did not have usually means a collision with an
  entry ahead of it, or with `main` as it moved. Merge `origin/main` into the
  branch locally and run that suite before pushing anything.

## Comments that need nothing from you

- **Dependency Review** (`dependency-review-pr-comment-marker`) is
  informational. It has something to say only when `package.json` or
  `package-lock.json` changed.
- **Queue Failure Attribution** (#3307): see the merge queue section above.
- **Branch Freshness** is a non-blocking nudge to bring `main` in. It never
  blocks a merge.
- **A red `main`** is reported on one issue that
  `main-ci-failure-notice.yml` opens, updates and closes. Read it when a
  failure looks unrelated to your diff; it may already be known.

## Before every push

These are the checks a contributor runs. Each one stands in for a CI job.

- **Typecheck:**
  `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`.
  - Exit 134 is an out-of-memory crash that checked nothing, not a pass.
  - `"incremental": true` can report a stale clean result.
  - When in doubt, put a deliberate type error in a changed file, confirm tsc
    reports it, then remove it.
- **Lint:** `npx eslint` on the changed files.
- **Ratchets:**
  `NODE_OPTIONS=--max-old-space-size=8192 npx jest tests/guards tests/guardrails tests/contracts`.
  - This is the `Ratchets` job.
  - It is required, and a docs-only change can still trip it.
- **The unit and integration suites the change reaches.**
  - Integration suites need the Postgres in `.env.test`.
  - Only one Jest run may hold the test database at a time; global setup takes
    a lock.
- **A new guard check goes into the guard that already owns the invariant.**
  A new guard file is named for its invariant:
  `tests/guards/no-epic-named-ratchets.test.ts` refuses a PR- or epic-named one,
  and the return of any guard the August 2026 retirements deleted.
- **The description follows `.github/PULL_REQUEST_TEMPLATE.md`.** Delete its
  dependency section when the package files are untouched. Add the rollback and
  risk analysis whenever the change is SIGNIFICANT.

## After a merge

This repository squash-merges, so the branch's own commits never reach `main`
under their own SHAs.

- **Start the next piece of work from `origin/main`**, not on top of the merged
  history: `git fetch origin main && git checkout -B <branch> origin/main`.
- **A force-with-lease push is fine** when the branch holds only commits that
  have already merged.
