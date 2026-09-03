> **Deprecated.** This described an AWS Terraform estate that was **never
> provisioned** — every `terraform apply` run failed on absent credentials (13
> attempts, 0 successes, no state file), and `infra/terraform/` was removed on
> 2026-09-02. Production is a single GCP VM running Docker Compose, deployed by
> Watchtower pulling from GHCR.
>
> Superseded by the **Production VM** section of
> [`CLAUDE.md`](../CLAUDE.md) for the topology, and by
> [`docs/disaster-recovery.md`](./disaster-recovery.md) for the recovery
> posture. Tracked in
> [#2226](https://github.com/RodnaPamet/inflect-compliance/issues/2226).

# Infrastructure (removed)

The content that stood here — VPC, RDS, ElastiCache, S3, Secrets Manager, CDN
modules, per-environment state separation and the day-1/day-2 runbooks — is
available in the git history at the commit that removed it. It is not kept
inline because an operator searching this file during an incident would find
procedures for infrastructure that does not exist, which is worse than finding
nothing.
