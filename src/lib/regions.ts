/**
 * Data-residency regions.
 *
 * `TenantRegion` (the Prisma enum) is the SET OF DECLARABLE regions. This
 * module is the source of truth for which of those are actually
 * **operationally provisioned** — i.e. have live infrastructure (RDS / S3
 * / KMS / Helm deploy / DNS) a tenant's data can sit in.
 *
 * Today production is single-region, so only `US_EAST_1` is provisioned.
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
    'US_EAST_1',
] as const;

/**
 * Planned-but-unprovisioned regions and the gating work each needs. The
 * `data-residency-foundation` ratchet requires every `TenantRegion` enum
 * value to be either in OPERATIONALLY_PROVISIONED_REGIONS or named here —
 * so a future enum addition without a provisioning plan fails CI.
 */
export const PLANNED_REGIONS: Readonly<Record<string, string>> = {
    EU_WEST_1:
        'Planned (EU residency): needs EU-resident RDS/S3/KMS + a per-region Helm deploy + DNS routing + EU-only sub-processor options. See docs/data-residency.md.',
    AP_SOUTHEAST_1:
        'Planned (APAC residency): needs AP-resident infrastructure + per-region deploy + DNS routing.',
    EUROPE_WEST1:
        'Where production runs (GCP europe-west1, Belgium). Declared one deploy ahead of use (#5288): the next deploy makes it the default and the provisioned region and moves every tenant to it.',
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
