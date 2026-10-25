# Change Management Policy

> **New to the codebase?** Start at [CONTRIBUTING.md](../CONTRIBUTING.md). The
> operational twin of this doc is [`docs/deployment.md`](deployment.md); the
> on-call rotation lives in [`docs/incident-response.md`](incident-response.md).

This policy describes how changes reach production. It captures the **rapid
release model already in effect** — semantic-release auto-versions main (on
each push that adds a test, spec or registered primitive or leaves the merge
queue empty, plus a daily run), every merge to `main` goes through the merge
queue's required checks, and the image built from it reaches production
without a further approval — and adds the written contract (approver matrix,
emergency bypass, audit trail) that the mechanism alone does not record.

## How a change reaches production

This is the pipeline as it runs on 2026-10-25:

1. **Merge.** A pull request reaches `main` only through the merge queue, whose
   required checks are `Lint`, `Typecheck`, `Test`, `Build`, `Security` and
   `Ratchets` (`ci.yml`'s required-set notes record why it is that set). This
   is the last gate a person or a check can hold a change at.
2. **Publish.** `.github/workflows/ghcr-publish.yml` runs on the push to `main`,
   builds the image, Trivy-scans it, and only on a passing scan pushes it to
   GHCR as `:latest` and `:sha-<short>`. A failed scan leaves the previous
   `:latest` in place.
3. **Roll out.** Watchtower on the production VM follows `:latest` and replaces
   the `app` and `worker` containers when it moves. A change to the Compose
   structure itself does not travel this way: it goes through
   `deploy/apply.sh`, run by an operator (`docs/deployment.md`).

Two stages this policy used to describe do not exist, and neither is implied
by anything above (#4056):

- **There is no staging environment.** Nothing deploys `docker-compose.staging.yml`;
  `npm run smoke:staging` runs against `localhost:3000`.
- **There is no approval between merge and production.** A `production` GitHub
  Environment with required reviewers was created on 2026-10-24, but no
  workflow deploys the application through it — the only workflow that names
  it is `scanner-vm.yml`, which operates the scanner VM. Building that deploy
  path needs CI credentials for the production VM, which this repository has
  never had; #4056 tracks it. Until it exists, a merge is a release to
  production within the time it takes to publish the image and for Watchtower
  to notice it.

A release waits while the merge queue is still building other entries, because
its commit, pushed straight to main, would invalidate every candidate in flight.
It never waits when it would raise a coverage floor: the release is what raises
the floors, and a floor that lags the live count protects less. So one release can carry several merges, and a version can trail a merge
by up to a day. Deploys do not wait for it: images are published on every push
to main. The rule is in `scripts/lib/release-queue-gate.js`.

It is **not** an ITIL change-advisory-board process: the repository ships several
production releases on a busy day (e.g. 2026-06-25 cut v1.585, v1.586, v1.587),
and a heavyweight board would break that cadence. It is **not** the SOC 2
auditor-facing deliverable (compliance derives that from this doc) and **not** a
replacement for the incident runbook (that is `incident-response.md`).

## Scope

A "change" under this policy is anything that can affect the production service:

- production application code deploys,
- infrastructure changes (Helm, Terraform),
- database migrations,
- secret rotations,
- dependency upgrades.

**Out of scope** (normal PR review applies, but the SIGNIFICANT+ second-approver
rule does not):

- documentation-only edits (`docs/`, `CHANGELOG.md`),
- marketing-site content (separate property),
- internal dashboards (Grafana panels — no customer impact),
- test-only changes (`tests/`, test-only workflow paths).

## Change classes

| Class | What it is | Process |
|-------|-----------|---------|
| **STANDARD** | Routine, low-risk, fully covered by the automated pipeline. ~95% of changes. | PR review + required checks green in the merge queue → merge → image published and rolled out by Watchtower. |
| **SIGNIFICANT** | Schema migration, security-affecting middleware change, dependency major bump, cross-tenant data backfill. | Same as STANDARD **plus** the PR description carries a rollback plan **and** a second engineer's `Sign-off:`. |
| **EMERGENCY** | Active production incident where the standard process would extend customer impact. | Incident commander declares EMERGENCY; the PR gets one explicit senior-engineer reviewer; it merges through the queue like any change and rolls out the same way. A retrospective PR follows within 5 business days. |

Grounding examples from the last 30 days of `CHANGELOG.md`:

- **STANDARD** — #1264 (`feat(api-docs): populate openapi.json + Swagger UI`),
  #1260 (`feat(observability): business-level KPI metrics`): feature PRs, CI
  green, merged through the queue.
- **SIGNIFICANT** — #1267 (`infra(db): read-replica routing`) touched the Prisma
  client + a migration-class concern; #1265 (`infra(cdn): CloudFront`) changed
  infrastructure. Both warrant a rollback plan + second sign-off.
- **EMERGENCY** — none in the window. The procedure below is the contract for
  when one occurs.

## Approval matrix

| Change type | Standard approver | Second approver (SIGNIFICANT+) |
|-------------|-------------------|--------------------------------|
| Application code change | PR reviewer | n/a for STANDARD |
| Database migration (`prisma/`) | PR reviewer | Eng lead OR DBA |
| Helm / Terraform change (`infra/`) | PR reviewer | Eng lead OR ops on-call |
| Dependency major bump | PR reviewer | Author monitors post-deploy for 24h |
| Secret rotation | PR reviewer | Security engineer |
| SCIM / SSO config change | PR reviewer | Security engineer |
| Sub-processor addition or activation | PR reviewer | Repo owner, recorded on the inventory PR |

There is no production approver after merge (see "How a change reaches
production"). The PR reviewer, and the second approver where the matrix names
one, are the people who decide a change reaches production.

### Sub-processors: who confirms which half of step 2

`docs/sub-processor-change-policy.md` step 2 asks compliance / legal to review a new
sub-processor before it is wired into the product. **These documents refer to "legal" as
an actor without ever identifying it.** The DPA template calls the signed agreement
"legal's deliverable" and marks four of its sections `[LEGAL REVIEW REQUIRED]`; there is
no `CODEOWNERS` file, no row in the matrix above said who approves a sub-processor until
this one, and every other `DPO` / `legal` mention in `docs/` describes a role at a
*customer* using the product. So the row above makes the repo owner the approver of
record, and the review is four confirmations — three of which are clerical:

| | confirmation | who |
|---|---|---|
| 1 | The sub-processor's own DPA is **executed**, not drafted | repo owner |
| 2 | Any retention commitment is **written into that DPA** — a statement on the vendor's product page does not count | repo owner |
| 3 | **No training on customer data** is committed contractually | repo owner |
| 4 | The **transfer mechanism** is identified, and where SCCs carry it, a **transfer impact assessment** is on file | needs legal competence |

Rows 1 to 3 are clerical: open the executed agreement and read it. Row 4 is not — a
transfer impact assessment is a documented assessment of the destination country's
surveillance law against the data being sent.

**Where a transfer impact assessment is not obtained, the decision to proceed without
one is recorded on the inventory pull request, naming who accepted the risk.** An
unticked box is not a decision, and it is the state a sub-processor stalls in: the one
proposed sub-processor's inventory pull request has carried all four confirmations
unticked and no review since it merged, because the step was unassigned rather than
refused.

The 30-day customer notice is a separate gate and is not an approval. It cannot start
before step 2 is recorded, and its clock runs from the notice date written into the
inventory entry — not from the inventory pull request merging.

## Audit trail

The durable record an auditor can request, all retained for the life of the repo:

- **Every change** = a GitHub PR + its merge-queue CI run. GitHub retains the PR,
  its reviews and the check results. There is no deployment-approval record,
  because there is no deployment approval (#4056).
- **What reached production** is the `ghcr-publish.yml` run for the merge commit:
  its image is tagged `:sha-<short>` with that commit, and its Trivy result is in
  the run. Releases are recorded in `CHANGELOG.md` (auto-generated by
  semantic-release, with the PR and commit linked). A release can batch several
  merges, so every merged PR is listed within a day of merging.
- **SIGNIFICANT+ sign-off** = the second approver's PR review, OR a PR comment /
  description line of the form `Sign-off: <name> (<reason>)`. Enforcement today is
  human PR review; a CI gate that blocks a SIGNIFICANT+ PR (conventional-commit
  `feat!:`, or any diff touching `prisma/schema/`) lacking a `Sign-off:` line is a
  documented follow-up — it needs PR-metadata access that the current structural
  ratchets (file scanners) do not have, so it is intentionally not retrofitted
  here.
- **Owner waiver for assistant-driven PRs** (2026-08-18). The repo owner has
  instructed Claude Code sessions not to hold a green PR waiting on the owner's
  `Sign-off:`, including SIGNIFICANT ones. Those PRs are merged once every
  required check is present and passing. The rollback plan and the risk
  assessment are still written into the PR — the waiver covers the wait for a
  countersignature, not the analysis behind it. Human-authored PRs are
  unaffected: the second-approver expectation above stands for them. See the
  working agreements in `CLAUDE.md`.

## Emergency change procedure

1. The incident commander declares **EMERGENCY** in the `#incidents` channel.
2. The author cuts the fix on a branch named
   `emergency/<incident-id>-<short-desc>`.
3. A second engineer (any senior engineer, **not** the author) reviews and
   approves. The on-call may not self-approve their own fix.
4. The fix merges through the merge queue and rolls out like any other change.
   There is no staging leg to skip and no deploy workflow to dispatch: the
   merge queue's required checks are the only gate, and an emergency does not
   bypass them.
5. Within **5 business days**, a retrospective PR titled
   `chore(retro): <emergency PR ref>` re-runs any skipped checks and documents:
   - what was bypassed,
   - why the standard process would have extended customer impact,
   - what regression coverage is added so the same bypass does not recur.

## Rollback policy

- **Application: rollback-by-redeploy.** Every published image is also tagged
  `:sha-<short>`, and no workflow deletes them from GHCR; rollback = run the
  previous image again (no rebuild). Because Watchtower follows `:latest`, that
  means pointing `:latest` back at the previous image, or pinning `app` and
  `worker` to its `:sha-` tag through `deploy/apply.sh` — a revert merged
  through the queue also works, but builds a new image.
- **Database migrations are non-rollback.** A migration that breaks production
  gets a **forward-fix** migration — the canonical pattern. Reverting a migration
  against live data is the larger risk.
- **Decision tree** — *"if I revert the app image without reverting the migration,
  does the app still work?"*
  - **Yes** → roll back the image.
  - **No** → forward-fix the migration (do not revert it).

This is the same posture documented operationally in
[`docs/deployment.md`](deployment.md).

## What "production-affecting change" excludes

Changes that resemble production changes but are out of scope for the
SIGNIFICANT+ second-approver requirement (they still go through normal PR review):

- marketing-site content (separate property),
- internal dashboards (Grafana panels — no customer-facing impact),
- documentation-only edits (`docs/`, `CHANGELOG.md`),
- test-only changes (`tests/`, test-only workflow paths).

A PR that mixes an out-of-scope edit with an in-scope change is classified by the
in-scope part.

## On-call coverage

- **Standard hours:** the PR reviewer and the merge queue's required checks gate
  production; there is no separate production approver.
- **Out of hours:** the on-call rotation reviews and merges.
  The rotation itself is defined in
  [`docs/incident-response.md`](incident-response.md); this policy cross-links
  there rather than duplicating it.
- **No self-approval:** the on-call engineer cannot approve their own PR. An
  emergency cut requires a different reviewer.

## Open policy questions

These are decisions for compliance / product / leadership, not engineering work.
They are listed honestly as unresolved; the doc does not pretend to answer them.

- **Customer change notification.** For SIGNIFICANT changes that alter
  customer-facing behaviour, do customers receive notice, and at what cadence?
- **Regulated change types.** Under SOC 2 / ISO 27001, are there change types that
  require customer pre-notification (e.g. data-handling changes, additions to
  encrypted-field columns per `docs/encryption-data-protection.md`)?
- **API deprecation window.** For breaking API changes, what deprecation window do
  we contract to? (The API consumer guide is the starting point.)
- **Per-tenant canary / pause.** For multi-tenant changes, do we offer
  customer-specific canary or pause capability? (Today: no — changes apply to all
  tenants at deploy time.)
- **Who is "legal", and transfer impact assessments.** Row 4 of the sub-processor
  confirmation table, and the `[LEGAL REVIEW REQUIRED]` sections of the DPA template,
  need competence these documents assume without naming. Is an assessment obtained
  from outside counsel for each non-adequate destination, or is the risk accepted and
  recorded? (Today: neither has happened for the one proposed sub-processor, which is
  why it is still inactive.)

Until each is decided, the operating default is: no contractual customer
pre-notification beyond the public `CHANGELOG.md`, and no per-tenant canary.
