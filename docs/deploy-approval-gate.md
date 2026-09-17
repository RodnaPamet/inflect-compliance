# The production publish approval gate

> **Policy twin:** the *who-approves-what* contract lives in
> [`docs/change-management-policy.md`](change-management-policy.md); the operational
> deploy guide is [`docs/deployment.md`](deployment.md). This page covers ONE thing:
> the human decision between "merged to `main`" and "production is running it",
> and the exact repository setting that decision depends on.

## The one setting a human must apply

**Nothing in this repository can create it.** Until somebody applies it, the
`promote-latest` job fails on every push to `main` and the rolling `:latest` tag
does not move. That failure is the design, not a bug — see
[Why it fails instead of shrugging](#why-it-fails-instead-of-shrugging).

1. GitHub → the repository → **Settings → Environments → New environment**.
2. Name it **exactly** `production-rollout`. The name is matched character for
   character, in three places that a test asserts are identical:
   `jobs.promote-latest.environment`, the workflow-level `APPROVAL_ENVIRONMENT`
   variable, and the API path the preflight reads.
3. Tick **Required reviewers** and add at least one person or team.
4. Leave **Deployment branches** at "All branches", or restrict to `main`.
   Restricting is fine; it is not a substitute for step 3.
5. Save.

Optional, and a real decision rather than a default:

- **Prevent self-review** stops the person who merged from approving their own
  rollout. It is the stronger posture and it is off by default. On a
  one-maintainer repository, turning it on makes the gate unusable — there is
  nobody else to click — so leave it off and accept that the gate is a
  deliberate click rather than a second pair of eyes. The preflight prints
  which of the two you have on every run.
- **Wait timer** is NOT an approval and the preflight rejects an environment
  that carries only one. A delay postpones an unreviewed image reaching
  production; it does not put anybody in front of it.

## What changed, and what deliberately did not

Production is a single VM running Docker Compose with Watchtower polling
`ghcr.io/rodnapamet/inflect-compliance:latest` **every 60 seconds**. Measured on
the VM: for the 2026-09-12 22:15:45 publish, Watchtower logged
`Found new … :latest image` at 22:37:18 and `Stopping /inflect-app-1` at
22:37:20. A merge therefore became a deployment about a minute after the image
published, with no human anywhere in the path — on a product whose 05:00 leaver
pass disables real accounts in customers' Entra/AD directories.

`.github/workflows/ghcr-publish.yml` now splits the two tags across two jobs:

| | `build-push` | `promote-latest` |
|---|---|---|
| Runs | every push to `main` | after `build-push`, on approval |
| Human in the path | **no** | **yes** — `environment: production-rollout` |
| Publishes | `:sha-<short>` (immutable) | `:latest` (the tag Watchtower polls) |
| Trivy gate | scans the local image before pushing | re-scans the pushed **digest** before moving the tag |

Three properties are preserved exactly as they were:

- **The scan still comes before the push, in both jobs.** `build-push` builds
  with `push: false` + `load: true`, scans the local image, and only then
  pushes. `promote-latest` re-scans before it moves the tag. GHCR never
  receives, and `:latest` never names, bytes Trivy has not passed.
- **`:latest` is still pushed last.** It is now last by a wider margin — a
  different job, after an approval — so an interrupted publish still cannot
  leave the rolling tag pointing at something whose immutable name is absent.
- **`main` can always publish.** Every commit is built, scanned and published
  as `:sha-<short>` with no approval. The approval gates the *rollout*, not the
  build, so there is always a rollback target in the registry.

One property is new: the digest that is approved is the digest that is
promoted. `promote-latest` moves the tag with `docker buildx imagetools create`
from `<image>@sha256:…`, which copies the manifest rather than re-uploading it,
and then reads `:latest` back and fails if it resolves to anything else.

## Why it fails instead of shrugging

`environment: production-rollout` in a workflow file is the entire gating
mechanism, and on its own it is worthless:

- GitHub **creates** an environment the first time a workflow names one that
  does not exist, with zero protection rules;
- a job whose environment protects nothing does not wait for anybody — it
  starts immediately, exactly as if the line were absent;
- a reviewer reading the diff sees the line and reasonably concludes a human is
  now in the path.

That is a change which looks like a gate and silently is not one, which is
worse than no change at all. So the first step of `promote-latest` reads the
environment back through `GET /repos/{owner}/{repo}/environments/{name}` and
hands the body to `scripts/assert-approval-gate.mjs`, which exits non-zero
unless a `required_reviewers` rule with at least one reviewer is really there.

It distinguishes three outcomes and only one of them proceeds:

| Observation | Exit | Meaning |
|---|---|---|
| `required_reviewers` with ≥1 reviewer | 0 | the gate is real; the tag moves |
| `protection_rules` readable, no such rule | 1 | the gate is provably **absent**; this job did not wait for anyone |
| payload missing, unreadable, or an unknown shape | 1 | **unknown** — a probe that failed is not a probe that passed |

The third row is the one worth arguing about, and it is deliberate: a failed
probe means *unknown*, never *zero*. The failure directions are not symmetric.
A red job leaves production running the image it was already running and
Watchtower rolls nothing; failing open puts an unreviewed image on customers'
directories within the minute.

The job is granted `actions: read` for exactly this call — `GITHUB_TOKEN` is a
GitHub App token, and that is the permission the endpoint requires for one. If
the preflight fails with a 403/404 while the environment exists, that
permission is the first thing to check.

## Rollback

Gating `:latest` does not change the documented rollback, because the
documented rollback never used `:latest`. From
[`docs/slos.md`](slos.md): *bad image → pin the previous GHCR tag and
`docker compose up -d`*. Every commit still publishes its `:sha-<short>` tag, so
the set of pinnable images is unchanged.

Three routes, fastest first:

1. **Pin the VM to a known-good tag.** Edit `/opt/inflect/docker-compose.prod.yml`
   to `image: ghcr.io/rodnapamet/inflect-compliance:sha-<good>` and
   `docker compose up -d app worker`. Watchtower does not fight a pinned tag.
   This is the incident move: it does not depend on GitHub being reachable.
2. **Move the rolling tag by hand**, from any machine with a token that can
   write the package:

   ```bash
   docker buildx imagetools create \
     --tag ghcr.io/rodnapamet/inflect-compliance:latest \
     ghcr.io/rodnapamet/inflect-compliance:sha-<good>
   ```

   Watchtower picks it up within 60 seconds. This bypasses the approval gate,
   and that is correct: it is a human at a keyboard, which is the thing the gate
   exists to require.
3. **Re-run the workflow** on the good ref (Actions → Publish image to GHCR →
   Run workflow) and approve the `promote-latest` job. Correct, audited, and
   the slowest of the three — it rebuilds the image.

## Operating notes

- **A newer push to `main` cancels an approval that is still waiting.** The
  workflow keeps `concurrency: cancel-in-progress: true`, so you always approve
  the newest image rather than working through a queue of stale ones. The cost
  is that if merges outrun approvals, `:latest` does not move — which is the
  correct direction, because nobody approved anything.
- **An approval that sits for a day is re-scanned before it lands.** Trivy's
  database moves; the re-scan in `promote-latest` runs against the same
  severities and the same `.trivyignore` as the first one, so a CVE disclosed
  during the wait blocks the rollout.
- **Approvals are audited by GitHub**, per run, under the environment's
  deployment history — which is the audit-trail row
  [`docs/change-management-policy.md`](change-management-policy.md) asks for.

## What the guards cover, and what they cannot

`tests/guardrails/latest-tag-requires-approval.test.ts` pins the shape: exactly
one step in the workflow can move `:latest` and it is in the gated job; the
ungated job cannot mint a `latest` tag by either metadata-action spelling; the
gated job declares the environment the preflight reads; the preflight runs
before the promote step, unconditionally; and the scanned digest is the promoted
digest. It also **executes** `scripts/assert-approval-gate.mjs` against
synthetic API payloads — one that must pass and eight that must not — so the
decision itself is tested rather than its spelling.

`tests/guardrails/publish-scans-before-push.test.ts` covers the scan ordering in
both jobs, and `tests/guardrails/security-gate-strictness.test.ts` enumerates
both Trivy gates' severity and exit-code declarations.

**None of them can see the repository setting.** Repository settings are not in
the source tree. A guard that asserted a fact it cannot observe would be the
exact failure this whole page is about. The preflight is the enforcement, at run
time, on the runner, with the tag still unmoved.
