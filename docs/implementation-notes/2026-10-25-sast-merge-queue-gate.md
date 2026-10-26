# 2026-10-25 — A code-scanning alert the PR introduces blocks its merge

**Commit:** `ci(security): block a merge-queue candidate whose PR introduced code-scanning alerts (#4047)`

## Design

Of the three static security gates, npm audit and Trivy blocked and were
ratcheted, while CodeQL blocked nothing. Neither CodeQL context can be
required. This workflow's `CodeQL SAST (<language>)` deliberately skips the
merge queue. GitHub-managed `Analyze (<language>)` has no workflow file that
could carry a `merge_group:` trigger, so requiring it would hang every merge.
On #4043 the PR-level `CodeQL` check failed on a new HIGH alert, and the PR
still reached position 1 in the queue.

The gate is a step of the `Security` job, which is already required and
already answers `merge_group`:

```
merge_group candidate  gh-readonly-queue/main/pr-<N>-<sha>
  Security job
    Gate: code-scanning alerts the PR introduces   (merge_group only)
      GET /pulls/<N>                     -> head sha
      GET /commits/<sha>/check-runs?check_name=CodeQL
        keep app == github-advanced-security
        none / unfinished  -> poll every 30 s, up to 10 min, then FAIL
        all completed      -> PASS only if every conclusion is success
```

The signal is GitHub's own `CodeQL` check run on the PR head. It compares the
PR's analysis with the base branch and fails when the PR introduces alerts at
or above the repository's threshold (Settings → Code security; default High
for security alerts). So a standing alert on `main` cannot block every PR.

## Files

| File | Role |
|---|---|
| `scripts/sast-alert-gate.mjs` | The gate: names the PR from the queue ref, reads its CodeQL check, fails closed |
| `.github/workflows/ci.yml` | The step, `checks: read` on the Security job, timeout 12 → 25 |
| `tests/guards/ci-flake-hardening.test.ts` | Security's timeout floor 12 → 25 |
| `tests/guardrails/security-gate-strictness.test.ts` | Pins the step, its trigger, its blocking, its permission, the check it reads |
| `CLAUDE.md` | Names the third gate beside the other two |

## Decisions

All three were the owner's, on 2026-10-25:

- **Inside the Security job, not a new required check.** It is in force on
  merge, with no ruleset change, and it inherits a context already verified
  to report `success` rather than `skipped` in the queue.
- **New alerts, not all open alerts.** Reading every open High+ alert on the
  PR ref would block every PR for as long as one alert stood on `main`.
- **Fail closed.** Only `success` passes, and a missing or unfinished check
  fails after 10 minutes. In six sampled PRs the check had always finished
  before queue entry (44 s at the closest), and it is posted on docs-only PRs
  too.

Two more, mine:

- **Queue-only.** On the PR itself the `CodeQL` check is already visible, and
  a step that waited for it on every push would slow every PR for nothing.
- **Skipped when `CODE_SCANNING_ENABLED` is not `true`.** That variable is
  what already gates the `codeql` job. With scanning off there is no check to
  read, and failing closed would block every merge.
