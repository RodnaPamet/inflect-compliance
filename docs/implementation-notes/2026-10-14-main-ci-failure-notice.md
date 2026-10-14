# 2026-10-14 — a failed CI run on `main` now reaches somebody (#3505)

**Commit:** `<sha> ci: notify on a failed main run (#3505)`

## Design

A failed `ci.yml` run on `main` had no notification path. Nothing watched it, so a
red `main` was discovered when a human happened to ask — twice on 2026-10-14:
E2E sat red for four consecutive runs in the morning (a missing i18n key crashing
the agent detail page, plus a spec listing six tab labels against a seven-tab
component; fixed in #3499 and #3503), then went red again hours later on #3518
with three agent specs timing out. Both times nobody was told.

**Why the existing rules did not catch it, which is the part worth writing down.**
The standing instruction is to merge when every REQUIRED check is green, and both
of those merges satisfied it. `E2E` is deliberately not a required status check,
so a pull request carrying a failed E2E reads `mergeStateStatus = UNSTABLE` — and
that is also what a perfectly healthy pull request reads when it carries a skipped
optional job. **The signal that something is wrong is indistinguishable from the
signal that nothing is**, which is not a lapse by whoever merged; it is the gap.

So this does not make E2E blocking. Making it required would hang every merge in
the repo on a suite that boots a full stack, and
`merge-queue-trigger-coverage.test.ts` records what that costs. It makes a red
`main` VISIBLE instead:

```
ci.yml completes on main
        │
        ▼
workflow_run: { workflows: [CI], types: [completed], branches: [main] }
        │
        ├── conclusion === 'success' ──► comment + close the open notice (if any)
        ├── cancelled / skipped ───────► return (a superseded queue run says nothing)
        └── anything else ─────────────► list the run's JOBS, classify each against
                                        the six required names, then update the
                                        open notice in place — or open one
```

Two halves do the real work.

**It names the failed jobs.** `conclusion: 'failure'` alone is not actionable, so
the job reads `actions:read` and calls `listJobsForWorkflowRun`, then renders a
table of failed job → "required check?". That second column is the diagnosis: if
nothing required failed, the issue says so in as many words, because that is the
explanation for why nobody was told until now.

**It closes itself on green.** An automated issue that only ever opens is one
people learn to scroll past, and a stale "main is failing" notice sitting over a
green `main` is worse than no notice — it teaches the reader that the notice means
nothing. The first passing run on `main` comments which run cleared it and closes
the issue.

## Files

| File | Role |
| --- | --- |
| `.github/workflows/main-ci-failure-notice.yml` | the whole mechanism — one `workflow_run` job, one `actions/github-script@v9` step |
| `tests/guards/ci-pipeline-integrity.test.ts` | `describe('a failed main run is reported (#3505)')` — 8 assertions over the workflow's shape |
| `tests/guardrails/ci-checks-unreachable-before-merge.json` | registers `main-ci-failure-notice.yml:notice` as `kind: never` with its reason and what covers it |
| `tests/guardrails/contended-json-format.test.ts` | the registry's `keyOrderSha` moved, as a key was appended |

## Decisions

- **It triggers on the workflow NAME, and the guard derives that name from
  `ci.yml` rather than repeating it.** A `workflow_run` filter matches
  `name:`, not the filename, so renaming `ci.yml`'s `name: CI` would silently
  stop this notifier for ever — the exact failure it exists to prevent, and the
  hardest kind to notice, since a notifier that never fires looks identical to a
  repository that is never broken. The assertion reads `ci.yml`'s own `name` and
  compares, so the rename reddens CI instead.

- **No `merge_group:` trigger, and that is correct rather than an omission.**
  `merge-queue-trigger-coverage` requires one of every workflow carrying a
  `pull_request` trigger, because those produce check contexts the queue waits
  on. This workflow produces none — it reacts to a completed run and writes an
  issue.

- **`cancel-in-progress: false`.** Each run carries a different conclusion to
  record; cancelling the loser would drop either the failure that opens the issue
  or the success that closes it.

- **`cancelled` and `skipped` are excluded from "failure".** A superseded merge
  queue run cancels normally and says nothing about the state of `main`.

- **The job had to be REGISTERED as PR-unreachable, not fixed.**
  `ci-check-reachability-before-merge` asks that every job a pull request cannot
  reach be registered with a reason, and this is the one job in the repo that is
  unreachable from a pull request *on purpose* — GitHub dispatches `workflow_run`
  from the default-branch copy of the workflow after an upstream run finishes, so
  its whole function is to react to something that has already merged. The
  residual is written down with it: the REST calls themselves are exercised only
  when `main` actually fails, so a wrong field name would surface on the first red
  main and not before.

- **Every needle in the guard names one call's own argument, not the API method.**
  The obvious spellings are ambiguous against this very script and the first cut
  had it twice: `issues.update` occurs twice (close, then re-body), so deleting
  the close left the test green; and `issues.create` is a prefix of
  `issues.createComment`, which occurs twice more, so that needle had three
  satisfying positions. `state: 'closed'`, `issue_number: existing.number, body,`
  and `title: TITLE` each occur exactly once, in the call they describe. Bounding
  the read to the branch was the other option and was tried —
  `braceBlockAfter` cannot lex the nested template literal on the "Still failing"
  line, so the anchor search runs off the target.

- **The pin assertion filters rather than loops.** `for (const u of uses)
  expect(u).toMatch(...)` stops at the first offender and, separately, makes the
  subject a for-of binding, which the Class D analyser cannot resolve and
  therefore counts as a blind spot — it pushed `UNANALYSABLE_READ_BASELINE` over
  its ceiling by exactly one. `expect(uses.filter(unpinned)).toEqual([])` names
  every offender and is analysable.
