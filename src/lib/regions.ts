/**
 * Data-residency regions.
 *
 * `TenantRegion` (the Prisma enum) is the SET OF DECLARABLE regions. This
 * module is the source of truth for which of those are actually
 * **operationally provisioned** — i.e. have live infrastructure (database,
 * object storage, keys, a deployment and DNS) a tenant's data can sit in.
 *
 * Today production is single-region, on GCP europe-west1 (Belgium), so only
 * `EUROPE_WEST1` is provisioned (#5288).
 * A tenant requesting any other region is refused at provision time with
 * a clear error — NOT silently defaulted. See docs/data-residency.md for
 * the foundation-vs-follow-up split.
 *
 * @module lib/regions
 */
import { ValidationError } from '@/lib/errors/types';
import type { TenantRegion } from '@prisma/client';

/**
 * Regions with fully-provisioned infrastructure TODAY. A `TenantRegion`
 * enum value NOT in this set is declared-but-unavailable. Add a region
 * here ONLY when its infra is live — never speculatively.
 */
export const OPERATIONALLY_PROVISIONED_REGIONS: readonly TenantRegion[] = [
    'EUROPE_WEST1',
] as const;

/**
 * Planned-but-unprovisioned regions and the gating work each needs. The
 * `data-residency-foundation` ratchet requires every `TenantRegion` enum
 * value to be either in OPERATIONALLY_PROVISIONED_REGIONS or named here —
 * so a future enum addition without a provisioning plan fails CI.
 */
export const PLANNED_REGIONS: Readonly<Record<string, string>> = {
    US_EAST_1:
        'Not provisioned: production has never run there. It was the column default until #5288, so every tenant read it; they were moved to EUROPE_WEST1, where production runs.',
    EU_WEST_1:
        'Planned (EU residency): needs an EU-resident database, storage and keys in AWS eu-west-1 (Ireland), a per-region deploy, DNS routing and EU-only sub-processor options. EUROPE_WEST1 is the EU region production runs in. See docs/data-residency.md.',
    AP_SOUTHEAST_1:
        'Planned (APAC residency): needs AP-resident infrastructure + per-region deploy + DNS routing.',
};

/** Is this region backed by live infrastructure right now? */
export function isProvisionedRegion(region: TenantRegion): boolean {
    return OPERATIONALLY_PROVISIONED_REGIONS.includes(region);
}

/**
 * Throw unless `region` is operationally provisioned. Called at tenant
 * provision time so a residency request for an unbuilt region is a clear
 * refusal, not a silent default to the production region.
 */
export function assertProvisionedRegion(region: TenantRegion): void {
    if (!isProvisionedRegion(region)) {
        throw new ValidationError(
            `region_not_provisioned: ${region} is not yet operationally available. ` +
                `Available: ${OPERATIONALLY_PROVISIONED_REGIONS.join(', ')}. ` +
                `See docs/data-residency.md.`,
        );
    }
}
