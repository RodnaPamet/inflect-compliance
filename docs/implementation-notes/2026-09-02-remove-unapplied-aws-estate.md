# 2026-09-02 — removing an AWS estate that was never provisioned

**Commit:** `<pending>` chore(infra): remove the AWS estate that was never provisioned

## Design

`infra/terraform/` described a complete AWS deployment — VPC, RDS, ElastiCache,
S3, Secrets Manager, CloudFront, an EKS deploy pipeline and helm charts. It was
never applied:

```
terraform.yml push runs   13 failure / 0 success   (every apply attempt)
.tfstate files            none, anywhere
repo + environment secrets  total_count 0 — AWS_ROLE_TO_ASSUME set nowhere
deploy.yml                workflow_dispatch only; last ran 2026-04-24, never succeeded
```

Production is, and has been, a single GCP VM running Docker Compose, deployed by
Watchtower polling GHCR. Removed here: the terraform tree, `infra/helm/`,
`deploy.yml`, `terraform.yml`, `helm-validate.yml` and the `helm-deploy` action.

## What made this worth writing down

**Fourteen guard suites existed to certify the shape of that estate**, and all
of them were green continuously. Twelve went red the moment the paths were
deleted, on top of the two retired in the companion change:

| guard | dead-path refs |
| --- | --- |
| `terraform-foundation` | 34 |
| `terraform-vpc-database`, `terraform-redis-storage` | 11 each |
| `deploy-workflow` | 9 |
| `terraform-workflow` | 7 |
| `deploy-staging-gate`, `terraform-secrets` | 5 each |
| `worker-autoscaling-coverage` | 4 |
| `cdn-config-coverage`, `helm-pdb-coverage`, `observability-provisioning-coverage` | 3 each |
| `helm-chart-foundation` | 2 |

Not one of them was wrong. Every assertion they made about the terraform was
accurate — the module really did set `storage_encrypted = true`, the workflow
really did gate production on staging. They were all statements about a
*design document*, phrased so they read as statements about infrastructure.

**The clearest instance is three levels deep.** `ci-pipeline-integrity` — a
meta-guard whose docstring is "guard the guards" — asserted the EXISTENCE of
`deploy-staging-gate` and `deploy-workflow`, which asserted the SHAPE of
`deploy.yml`, which had never deployed anything. Three tiers of green, none
touching conduct.

## Files

| file | role |
| --- | --- |
| `infra/terraform/`, `infra/helm/` | deleted — 37 tf files, 2 charts, never applied |
| `.github/workflows/{deploy,terraform,helm-validate}.yml`, `.github/actions/helm-deploy/` | deleted |
| 12 guard suites | deleted — listed above |
| `tests/guards/ci-pipeline-integrity.test.ts` | two registry entries removed; count contract 7 → 5 |
| `tests/guardrails/ci-checks-unreachable-before-merge.json` | 11 keys removed (25 → 14) |
| `ci-check-reachability-before-merge.test.ts` | census floors re-baselined |
| `docs/infrastructure.md`, `docs/cdn.md` | reclassified `deprecated` |
| `docs/incident-response.md` | operator translation table added at the top |
| `.github/workflows/ghcr-publish.yml` | comment corrected — it is now the only deploy path |

## Decisions

- **The one thing that could genuinely have broken was checked first.**
  `ghcr-publish.yml` references `deploy.yml`, and GHCR *is* the live path. The
  reference turned out to be a prose comment ("separate from the heavier
  deploy.yml pipeline"), and `deploy.yml` was `workflow_dispatch`-only with its
  auto-trigger commented out pending a staging EKS environment that was never
  provisioned. Nothing functional. The comment now says GHCR is the only path,
  because the next reader would otherwise go looking for the other one.

- **The census floor was lowered once, deliberately, and not to the current
  number.** Deleting four workflows took the census from 39 jobs to 26, so the
  `>= 30` floor would have gone red on a *correct* deletion — the failure mode a
  floor exists to avoid. Re-baselined to 18, roughly two thirds: a floor set AT
  the count turns every future deletion into a floor edit, and the purpose of
  those three assertions is to catch a parser yielding nothing, not to pin an
  inventory.

- **`ci-pipeline-integrity`'s `toHaveLength(7)` did its job and is kept.** It
  refused to let two entries vanish quietly; updating it to 5 was a deliberate
  edit with the reason recorded inline. That is the difference between a count
  that documents a contract and a floor that documents a fact.

- **`infrastructure.md` and `cdn.md` are `deprecated`, not deleted.** CLAUDE.md's
  own guidance — inbound cross-links survive, and the banner tells a reader
  where to go. Their bodies are replaced rather than annotated, because an
  operator searching a 436-line file during an incident would otherwise find
  detailed procedures for infrastructure that does not exist, which is worse
  than finding nothing.

- **`incident-response.md` gets a translation table rather than a rewrite.** It
  is 684 lines of runbook and the wrong move is a half-finished rewrite that
  leaves some procedures real and some fictional with no way to tell which. The
  table at the top maps every `kubectl` / `helm rollback` /
  `restore-db-instance` / PagerDuty instruction to what an operator should
  actually do on the VM, including the two that have no equivalent: there is no
  PITR, and there is no paging path. A full rewrite is follow-up work.
