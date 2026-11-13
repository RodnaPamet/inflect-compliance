# Data Residency

> **New to the codebase?** Start at [CONTRIBUTING.md](../CONTRIBUTING.md). Related:
> [`docs/data-retention.md`](data-retention.md) (lifecycle) and
> [`docs/multi-region.md`](multi-region.md) (cross-region DR design).

This document describes the data-residency **foundation** that ships today and
the architecture work that remains. It is deliberately precise about the line
between the two, because "EU data residency" as customers mean it is a multi-week
architectural shift, not a column.

## What residency means today vs. tomorrow

**Today — single-region, declarative.** Production runs in one region: one GCP
VM in `europe-west1` (Belgium), recorded as `EUROPE_WEST1`. Every tenant shares
its database, storage and keys. `Tenant.region` is **declarative**: it records
the customer's residency commitment and gates provisioning, and the data lives
wherever production is deployed. Until #5288 every tenant read `US_EAST_1`
("United States (East)"), the column default, although production has never run
there; the default and every stored row moved to `EUROPE_WEST1` (migrations
`20261113090000` and `20261113120000`). This is the foundation; physical per-region storage is the
deferred work below.

**A second region (deferred target state).** With one region, "residency" is
where production runs, and today that is the EU. A commitment to keep a tenant's
data in a region OTHER than the one production runs in needs per-region
infrastructure, and then means:

- Tenant data (`Risk`, `Control`, `Evidence`, `AuditLog`, …) is stored in that
  region's own database, storage and keys.
- Auth (login + JWT minting) happens in that region.
- Cross-region API calls are blocked by middleware; an authenticated user lands
  in the region that owns their tenant.
- Sub-processors (Stripe, Sentry, SMTP) that lack a region-only option are
  called out as exceptions in the sub-processor list.

## What's in this PR (foundation)

- **Schema** — a `TenantRegion` enum (`US_EAST_1` / `EU_WEST_1` /
  `AP_SOUTHEAST_1` / `EUROPE_WEST1`) and a `Tenant.region` column (default
  `EUROPE_WEST1`, indexed for per-region operational scans). Migration
  `20260626120000_add_tenant_region`; `EUROPE_WEST1` and its default since #5288.
- **Provisioning** — `createTenantWithOwner` threads `region` and validates it
  against `OPERATIONALLY_PROVISIONED_REGIONS` (`src/lib/regions.ts`). A request for
  a region without live infrastructure is **refused** with a clear
  `region_not_provisioned` validation error — never silently defaulted.
- **`src/lib/regions.ts`** — the source of truth for which enum values are
  actually provisioned (today: `['EUROPE_WEST1']`) and the planned ones with their
  gating work.
- **Audit trail** — every tenant's region at creation is recorded in the
  `AuditLog` as `TENANT_REGION_SET` (category `access`): the durable artifact a
  compliance reviewer reads.

## What's NOT in this PR (follow-up)

These are separate, larger pieces of architecture work:

- **Provisioning a second region's infrastructure** (Terraform + Helm + DNS +
  per-region secrets/KMS).
- **The routing layer** — which region answers `api.inflect.app/<tenant-slug>`
  (sub-domain / DNS / edge).
- **The repository-level region-mismatch guard** — a `RequestContext.region` that
  every tenant read asserts against the deploy region. Vacuous in a single-region
  deploy, load-bearing the moment a second region exists; deferred until that
  deploy is real so the seam is built against actual infrastructure.
- **A cross-region migration tool** ("move tenant X from US to EU"). Tenants stay
  in the region they were created in.
- **Sub-processor EU residency** (Stripe, Sentry, SMTP must also be EU-resident;
  some offer it, some do not).
- **Sign-up region selection + geolocation default** — the sign-up surface for the
  choice (IP-derived default via an edge header, not application-time GeoIP).

## Open questions for legal / compliance review

Decisions for compliance / legal, not engineering. Listed honestly as unresolved:

- Which regions does our SOC 2 commitment cover?
- Which jurisdictions **require** in-region storage? (GDPR is not strictly one — it
  requires an adequacy / transfer mechanism, a different question.)
- When a customer requests a cross-region migration, what contractual notice
  period applies?
- Backups: when a production database backup is copied cross-region for DR (see
  `docs/multi-region.md`), does that copy create a residency violation for an EU
  tenant? This intersects the DR design directly.

Until each is decided, the operating default is: every tenant is `EUROPE_WEST1`
(the only provisioned region), and a request for any other region is refused.
