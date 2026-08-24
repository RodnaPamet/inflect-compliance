# 2026-08-25 — closing the "check that can only fail after merge" class

**Commit:** `ci(guard): make PR-unreachable jobs a registered, triaged class`

## Design

A CI check that cannot run at PR time can only report a failure **after** the
bad commit is on main. The PR goes green, main breaks, and the breakage is
usually mis-attributed to whoever merged next. Four instances surfaced in one
week:

| instance | how it hid |
|---|---|
| `Coverage` | push/schedule/dispatch-only — a coverage regression is only ever seen post-merge |
| `container` path filter | skipped `Docker Build` on source-only PRs |
| `Bundle Analyze` | needs a `perf-watch` label, so a dependency bump lands green |
| `semantic-release` | main-only **and** only acts when a commit cuts a release — #2120 sat latent through four main commits |

Patching those four individually would leave the fifth to be found the same
way: by it breaking. So the change is a **census plus a registry**, not four
patches.

### The fourth hole, found by building the census

`npm run build:worker` — the esbuild bundle of `scripts/worker.ts`,
`scripts/scheduler.ts` and three seeders, with every `src/` import inlined —
ran in exactly one place: `RUN npm run build:worker` at `Dockerfile:68`. The
only job that reaches it is `Docker Build`, which the `container` path filter
skips on any PR touching only `src/`. A source change that broke the worker
bundle therefore passed every PR check and either turned main red at
`Docker Build` or shipped a broken worker image that Watchtower pulls into
production.

It costs **0.31 s**. There was never a cost reason for it to live only in the
image build. It now runs in the PR-reachable `Build` job.

### Why an expression evaluator, not a regex

The obvious implementation — "does the `if:` mention `github.event_name`
without mentioning `pull_request`" — is wrong on this repo's real conditions.
Several jobs carry `if: github.event_name != 'merge_group'`, which excludes the
merge **queue** and is fully PR-reachable. A substring rule marks them
unreachable and fills the registry with false entries.

So the guard parses the subset of GitHub expression syntax in use and asks a
precise question: with `github.event_name` bound to `'pull_request'`, is the
condition **satisfiable**? Unresolvable terms (`contains()`, `vars.*`,
`needs.*`, `always()`) evaluate to `unknown` rather than to a guess, and a job
reachable only when an unknown is true is classified `conditional` — which
still requires triage, because `Bundle Analyze`'s label gate is exactly that
shape.

Writing that evaluator surfaced two bugs of its own, both pinned as
regressions:

- The Tri value `'unknown'` is itself a JS string, so `typeof x === 'string'`
  treated an unresolvable term as a **string literal** and compared it. That
  silently resolved `vars.CODE_SCANNING_ENABLED == 'true'` to `false` and
  classified CodeQL and Docker Build as permanently unreachable.
- The identifier regex omitted `-`, so `needs.fmt-validate.result` parsed as
  `needs.fmt`, the rest of the expression was abandoned, and a provably
  unreachable job was reported as merely conditional.

Both would have produced a registry full of confident, wrong entries.

## Files

| file | role |
|---|---|
| `.github/workflows/ci.yml` | runs `npm run build:worker` in `Build`; drops `pull_request: branches: [main]` |
| `.github/workflows/integration-stress.yml` | drops the same base-branch filter |
| `tests/guardrails/ci-check-reachability-before-merge.test.ts` | the census + evaluator + ratchet |
| `tests/guardrails/ci-checks-unreachable-before-merge.json` | 26 triaged entries: reason + covering check |

## Decisions

- **`branches:` and `paths:` are not equivalent, and conflating them would make
  the guard unlandable.** `branches:` scopes by the PR's *base*, so a stacked
  PR fired **zero** ci.yml jobs — not "skipped", which at least reports a
  neutral context, but never triggered, so the PR page showed no checks and
  nothing looked missing. `paths:` scopes by content, which is how
  helm/terraform correctly avoid running on unrelated PRs. `branches:` is now
  banned outright; each `paths:` scope is registered.

- **The registry records what is NOT covered, in those words.** Three entries
  say `NOT COVERED AT PR TIME` — both Coverage jobs and the Bundle Analyze
  label gate. A registry that only recorded comfortable answers would be a list
  of claims nobody checks; the value is that the open gaps are now written down
  where CI keeps them honest.

- **The guard asserts its own census is plausibly sized.** The characteristic
  failure of a scanner like this is a parser that yields nothing and passes
  silently — an absence read as a pass. Floors of 10 workflows / 30 jobs / 8
  PR-reachable sit well under the real counts (14 / 39 / 12), so ordinary
  growth does not trip them but a collapsed parse does.

- **Not named for the work that produced it.** The first filename began `pr-`,
  which the repo's own `no-epic-named-ratchets` guard rejects. Renamed rather
  than allowlisted — CLAUDE.md says shrink that list, not grow it.

- **The bundle-size budget test is a live example of the same disease and is
  NOT fixed here.** `tests/guardrails/bundle-size-budget.test.ts` runs on every
  PR, finds no `.next/app-build-manifest.json`, takes its skip branch and
  reports a green pass — a check that has never once been able to fail on a PR.
  Making it fail closed belongs in its own diff.
