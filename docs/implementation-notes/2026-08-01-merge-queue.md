# 2026-08-01 — merge queue with a lean gate

**Commit:** `<pending> ci: add merge_group triggers + a lean queue gate`

## Design

### The collision class

Two PRs each pass CI against `main` **as it was when their run started**.
Both merge. Nothing ever tests the combination.

Git only objects when the collision is *textual*. When it is *semantic* the
merge is clean and `main` lands red:

- PR A adds tests against an exported helper; PR B renames or deletes it. No
  overlapping lines, no conflict, `Typecheck` red on `main`.
- Two PRs each bump a different structural-ratchet floor (this repo has dozens
  — `CURRENT_BASELINE`, `SANITISER_COVERAGE_FLOOR`, the border-tone budget, the
  unbounded-`findMany` budget). Both land; neither count is right afterwards.
  If they happened to bump the *same* line, git catches it; if not, nothing does.
- PR A adds a Prisma model; PR B adds a `findMany`. Layer C-completeness in
  `tests/guardrails/schema-index-coverage.test.ts` fires only on the combination.

The cost is not the redness. It is that every concurrent PR then inherits the
failures, so the next author has to work out which of the red jobs are theirs —
a tax this repo has already paid (see `docs/implementation-notes/` on
merge-ref CI traps, where "the PR is red because `main` is red" was a recurring
diagnosis).

GitHub's merge queue closes it: the queue builds a temporary
`refs/heads/gh-readonly-queue/main/pr-<n>-<sha>` ref of `main` + everything
already queued + the new PR, runs the required checks against **that**, and
merges only if they pass.

### Why a queue and not `strict: true`

"Require branches to be up to date before merging" reaches the same
correctness, by forcing every PR to rebase onto the current `main` and re-run
CI before it may merge. It is strictly worse here, and the repo's own numbers
say by how much.

Over the 30 days to 2026-08-01:

| measure | value |
| --- | --- |
| commits on `main` | 634 |
| of those, `chore(release)` bot commits | 292 |
| genuine merges | 342 |
| merged PRs | 200+ |
| busiest single day | 66 commits on `main` |

`main` moves roughly **once an hour, around the clock**, and semantic-release
pushes a `chore(release)` bump after *every* merge — so each merge advances
`main` twice. A full CI pass is ~35 minutes at the `Test` job's budget.

Under `strict: true`, a PR that finishes CI has already been overtaken by the
next merge and must rebase and re-run. Throughput collapses to at most one
merge per full CI cycle, with no batching: `strict` re-runs each PR alone.
The queue instead batches — it can build one combined ref for several queued
PRs and test them together, so a quiet hour costs one gate run rather than N.

### The invariant that decides whether this works

> A job that **skips** reports `skipped`, and branch protection counts that as
> a pass. A workflow that never **triggers** reports nothing at all, and the
> required check stays pending forever — the queue hangs and every merge in the
> repo stalls, with no error anywhere to say why.

So `merge_group:` goes on **every workflow file that could own a required
status check** — mechanically, every workflow with a `pull_request` trigger,
because that is what produces a PR check context. Not just `ci.yml`.

Leanness is achieved **inside** a triggered workflow, by making expensive jobs
skip on `github.event_name == 'merge_group'`. Never by leaving a workflow
untriggered.

`tests/guardrails/merge-queue-trigger-coverage.test.ts` holds the invariant.

### The lean set

Two questions decide each job: *does it catch a semantic collision?* and *does
it already run post-merge?* The second was checked empirically against CI run
`30661300568` (push to `main`, 2026-07-31) — every job below reports on a push
to `main`, so skipping one in the queue declines a **third** run rather than
removing a run.

| job | in queue | why |
| --- | --- | --- |
| `changes` | run | cheap; its `paths-filter` step is skipped (see below) |
| `lint` | run | collisions surface as lint/compile failures |
| `typecheck` | run | **the** collision catcher — a rename on one side, a caller on the other |
| `test` ×4 + `test-summary` | run | unit failures + every structural ratchet and count guard |
| `build` | run | `next build` catches what `tsc` alone does not |
| `security` | run | two PRs can both move `package-lock.json` |
| `e2e` | **skip** | ~17-25 min serial, the longest job in the pipeline; a collision that typechecks and unit-passes but only breaks a browser flow is a different class |
| `docker` + `trivy` | **skip** | ~40 + ~12 min; a merge collision cannot produce a container-scan finding — the image CVE surface is a property of the base image and the dependency tree |
| `codeql` | **skip** | SAST finds taint patterns, not "PR A renamed what PR B calls"; and its SARIF upload would file a code-scanning analysis against a throwaway queue ref |
| `coverage`, `load-smoke` | skip (unchanged) | already `push`/`schedule`-only |

Sibling workflows: `bundle-analyze`, `helm-validate` and `terraform` receive the
trigger but skip all jobs in the queue. The trigger is insurance — if one of
their contexts is ever marked required, it reports `skipped` (a pass) instead of
hanging forever. `branch-freshness` is the single exemption: it is
contractually non-blocking (`exit 0` always), so it can never be a required
check, and its measurement reads `github.event.pull_request.*`, which is
undefined under `merge_group`.

### Stated residual risk

A collision that compiles, passes the unit suite and every structural ratchet,
and breaks only end-to-end behaviour, container packaging, or a SAST rule will
still reach `main`. It is caught by the post-merge run on `main` rather than
pre-merge. That is the trade, made deliberately: pre-merge coverage of the
observed collision class, in exchange for not serialising ~50 minutes of
E2E-plus-container work onto every merge.

### The quiet breakages, handled

- **`paths-filter`.** A `merge_group` event carries no base/head pair, so
  `dorny/paths-filter` errors ("requires 'base' input to be configured"). The
  step is skipped in the queue and the job output defaults to `|| 'true'` — the
  conservative value, erring toward running more.
- **`paths-ignore` does not apply.** `merge_group` accepts no path filter, so a
  docs-only PR that skips CI on `pull_request` **will** run the lean gate on its
  way through the queue. Deliberate: a queued merge is a merge into `main`.
- **Concurrency.** `ci.yml` is keyed on `github.ref`, which for a queue run is
  the per-entry `gh-readonly-queue` ref, so entries cannot cancel each other.
  `cancel-in-progress: false` is load-bearing twice over here — GitHub reports a
  **cancelled** queue run as a **failure**, which ejects the PR from the queue.
- **`github.event.pull_request` is undefined** under `merge_group`. The only
  reader in a queue-running job is the `security` job's dependency-review step,
  already gated on `github.event_name == 'pull_request'`.
- **Rollup over a skipped matrix.** `test-summary` is `if: ${{ !cancelled() }}`
  and reads `needs.test.result` — it is not built on `success()`, so it still
  reports when its `needs` are skipped. Unchanged, and verified to still hold.

## Enablement runbook

> **The order is load-bearing.** The workflow change must be on `main` **before**
> the queue is switched on. Reversed, the queue waits on checks that never fire
> and every merge in the repo hangs with no error message.

The queue is a **repository setting**, not a file in this repo. It has *not*
been enabled by this change — the steps below are for the repo owner.

**Precondition, and it is not optional.** As of this change `main` has **no
required status checks at all**: there is no classic branch-protection rule
(`GET /branches/main/protection` → 404), and the only active ruleset is a
Copilot-code-review rule. A merge queue with zero required checks builds the
combined ref and merges without gating on anything — all of the serialisation
cost, none of the benefit. Required checks must be selected in the same rule
that turns the queue on.

1. **Confirm this change is merged to `main`.** `.github/workflows/ci.yml`,
   `bundle-analyze.yml`, `helm-validate.yml` and `terraform.yml` must all carry
   `merge_group:` on the default branch.

2. **Settings → Rules → Rulesets → New branch ruleset** (or edit an existing
   one), targeting the default branch. Enable:
   - **Require a pull request before merging** — the queue's prerequisite.
   - **Require status checks to pass**, and add these contexts, which are the
     jobs that run in the queue:
     - `Lint`
     - `Typecheck`
     - `Test` — the summary job, **not** `Test (shard N/4)`; the summary name is
       stable across shard-count changes
     - `Build`
     - `Security`
   - **Require merge queue**. Defaults are fine to start:
     merge method `Squash`, build concurrency `5`, minimum group size `1`,
     maximum group size `5`, wait time `5` minutes, and *only merge non-failing
     pull requests*.

   Do **not** add `E2E`, `Docker Build`, `Trivy Image Scan`, `CodeQL SAST
   (javascript-typescript)`, `Coverage (≥60%)`, `Load Smoke (k6)`,
   `Detect changes`, or `Branch freshness (behind-base nudge)` to the required
   set. The first six skip in the queue by design (they still run on the PR and
   on `main`), so requiring them buys nothing; `Detect changes` runs but is
   internal plumbing for the container jobs, not a gate; and `Branch freshness`
   has no `merge_group` trigger at all, so requiring it would hang every merge.

3. **Decide what happens to docs-only PRs — this bites immediately.**
   `ci.yml`'s `pull_request` trigger carries `paths-ignore: docs/** · **/*.md ·
   .github/ISSUE_TEMPLATE/** · LICENSE · .gitignore`, so a PR touching only
   those paths produces **no** CI check runs at all. The moment step 2's
   required checks exist, such a PR sits on *"Expected — waiting for status to
   be reported"* and cannot merge. (This is the footgun `ci.yml`'s own trigger
   docblock already flags.) Two workable answers:

   - **Recommended — drop `paths-ignore` from the `pull_request` trigger.**
     Pure-docs PRs are rare here (implementation notes ride along with the code
     PR that produced them), and the queue already runs full CI on a docs-only
     merge because `merge_group` accepts no path filter. Dropping it makes the
     PR and the queue agree.
   - **Or leave it and merge docs-only PRs via a ruleset bypass.** Workable,
     but it is a standing manual exception.

   A "shim" workflow on the complement paths that re-emits the same check names
   is the usual third option and is **not** recommended here: `paths` and
   `paths-ignore` are not exact complements, so a PR touching both `docs/` and
   `src/` would trigger *both* workflows and produce two check runs with the
   same name — which of them branch protection reads is not something to rely
   on.

4. **Keep the release bot able to push.** `semantic-release` pushes
   `chore(release)` commits directly to `main`. This repo has been bitten before
   by branch protection freezing that bot (GH006). If the new ruleset adds any
   push restriction, add the release identity to **Bypass list**. Requiring a PR
   for *human* pushes does not block the bot's direct push unless a restriction
   rule is also enabled.

5. **Verify on the first queued PR:**
   - The PR shows **"Merge when ready"** instead of "Squash and merge".
   - After clicking it, a run appears under Actions on a ref named
     `gh-readonly-queue/main/pr-<n>-<sha>` with `event: merge_group`.
   - In that run: `Lint`, `Typecheck`, `Test (shard 1..4/4)`, `Test`, `Build`,
     `Security`, `Detect changes` are **green**; `E2E`, `Docker Build`,
     `Trivy Image Scan`, `CodeQL SAST`, `Coverage`, `Load Smoke` are
     **skipped**; nothing is stuck **pending**.
   - The PR merges automatically when the run goes green.

   A check sitting **pending forever** is the failure this design guards
   against: it means some required context belongs to a workflow with no
   `merge_group` trigger. Fix by removing that context from the required set, or
   by adding the trigger to its workflow.

6. **Rollback** is the same settings toggle — turn *Require merge queue* off.
   The `merge_group:` triggers are inert on a repo with no queue, so no revert
   of this change is needed or wanted.

## Files

| file | role |
| --- | --- |
| `.github/workflows/ci.yml` | `merge_group:` trigger; `e2e` / `docker` / `codeql` skip in the queue; `changes` gates its `paths-filter` step and defaults its output to `'true'`; lean-set + concurrency rationale in comments |
| `.github/workflows/bundle-analyze.yml` | `merge_group:` trigger; analyze job skips in the queue, and its PR-label condition is now explicit rather than relying on null-propagation |
| `.github/workflows/helm-validate.yml` | `merge_group:` trigger; both jobs skip in the queue |
| `.github/workflows/terraform.yml` | `merge_group:` trigger; `fmt-validate` skips in the queue, and every other job `needs:` it so they skip in lockstep |
| `.github/workflows/branch-freshness.yml` | documents why it deliberately has **no** trigger |
| `tests/guardrails/merge-queue-trigger-coverage.test.ts` | the ratchet — trigger coverage, no-stale-exemptions, lean set not hollowed out, the three quiet breakages, and this note's runbook |
| `tests/guards/ci-pipeline-integrity.test.ts` | registers the new ratchet as a sixth pipeline pillar, so it cannot be deleted or gutted without a red meta-ratchet |
| `docs/_status/doc-classification.json` | classifies this note |

## Decisions

- **Coverage is defined by "every `pull_request` workflow", not "every workflow
  currently required".** There are zero required checks today, so a
  required-context-driven rule would have been vacuous and would have silently
  stopped protecting the moment the owner picked a context. A `pull_request`
  trigger is what *produces* a candidate context, so that is the honest
  boundary — and it is mechanical, which is what a ratchet needs.

- **Sibling workflows get the trigger even though every job skips.** The trigger
  costs nothing (an empty workflow run) and removes an entire class of
  future footgun: mark `helm-validate` required tomorrow and it reports
  `skipped` → pass, rather than hanging every merge in the repo.

- **`helm-validate` and `terraform` skip rather than run.** Both are path-scoped
  infra checks and `merge_group` accepts no path filter, so without the skip
  they would run on *every* queued merge, infra-touching or not. Both also fetch
  from third-party registries (`helm dependency update`, `terraform init`),
  which would convert an upstream network flake into a blocked merge.

- **`codeql` skips for the SARIF reason as much as the time reason.** Analysing
  a `gh-readonly-queue` ref files a code-scanning analysis against a branch that
  ceases to exist seconds later. This repo has already been burnt by partial
  SARIF state leaving both CodeQL and Trivy showing "reporting errors" on the
  Security tab — the `concurrency` docblock in `ci.yml` records that incident.

- **The guard locks the *keep* set, not only the *skip* set.** The dangerous
  regression is not "someone forgets a trigger" (that fails loudly, if
  confusingly). It is "someone adds `!= 'merge_group'` to `typecheck` to make
  the queue faster" — after which the queue still runs, still goes green, and
  no longer tests the thing it exists to test. `QUEUE_ENFORCED_JOBS` fails CI on
  exactly that.

- **`branch-freshness` is exempted rather than trigger-and-skip**, so its
  status is stated rather than papered over: it is contractually non-blocking,
  therefore it can never be a required check, therefore the invariant does not
  reach it. The guard verifies that premise — it asserts the workflow still
  says "Non-blocking BY DESIGN" and still ends in `exit 0`, so the exemption
  cannot outlive its own justification.

- **The queue is not enabled here.** It is a repository setting, the ordering is
  load-bearing, and enabling it before these triggers are on `main` hangs every
  merge. The runbook above is the handoff.
