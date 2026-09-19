/**
 * Privacy & data-protection posture — read-only aggregate for the
 * `/admin/privacy` page.
 *
 * This usecase reports what the platform ACTUALLY does with tenant data
 * today. It is deliberately read-only: every control it describes is
 * configured elsewhere (or not configurable at all), and inventing setters
 * here would imply tenant-level knobs the backend does not have.
 *
 * Honesty constraints baked into the shape below — each exists because the
 * naive version of this page would overstate the product:
 *
 *   • `residency.declarativeOnly` — `Tenant.region` records the customer's
 *     residency COMMITMENT. Production is single-region, so the value is not
 *     a statement about where bytes physically live. Reporting the region
 *     without this flag would read as enforcement.
 *   • `retention.tenantConfigurable: false` — the sweep windows are module
 *     constants in `jobs/data-lifecycle.ts`, not per-tenant settings. Only
 *     per-record Evidence retention is user-controlled.
 *   • `dsar.intakeEnabled: true` / `automatedFulfilment: false` — rights
 *     requests can be RECORDED and tracked in the admin register, but nothing
 *     exports or erases. `jobs/dsar-export.ts` still throws unconditionally.
 *     `dsar-erasure.ts::eraseUser` no longer does — Stage 3 implemented the
 *     cascade (#2287) — but it is still absent from `register-schedules` and
 *     `executor-registry` and NOTHING IN `src/` CALLS IT, which is what this
 *     flag is about: fulfilment is not AUTOMATED, and an implemented function
 *     with no caller automates nothing. Flip this only when something in the
 *     product can actually reach it. The two flags are deliberately separate.
 *     Collapsing them into one "DSAR works" boolean is exactly the
 *     overstatement this module exists to prevent.
 *
 * @module app-layer/usecases/privacy-posture
 */
import type { RequestContext } from '../types';
import type { TenantRegion } from '@prisma/client';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanViewAdminSettings } from '../policies/admin.policies';
import { isProvisionedRegion } from '@/lib/regions';
import {
    DEFAULT_SOFT_DELETE_GRACE_DAYS,
    DEFAULT_EVIDENCE_PURGE_DAYS,
} from '../jobs/data-lifecycle';
import { DSAR_COOLING_OFF_HOURS, DSAR_EXPORT_TTL_DAYS } from '@/lib/dsar';

export interface PrivacyPosture {
    encryption: {
        /** Tenant holds a wrapped per-tenant DEK (v2 envelope). */
        perTenantDek: boolean;
        /** A DEK rotation is mid-flight (previous key still retained). */
        rotationInFlight: boolean;
    };
    residency: {
        region: TenantRegion;
        /** The region has provisioned infrastructure behind it. */
        provisioned: boolean;
        /** Always true today — production is single-region. */
        declarativeOnly: boolean;
    };
    retention: {
        softDeleteGraceDays: number;
        evidencePurgeDays: number;
        /** False — windows are platform constants, not per-tenant settings. */
        tenantConfigurable: boolean;
        /** Evidence rows carrying an explicit per-record retention rule. */
        evidenceWithRetentionRule: number;
    };
    subProcessors: {
        /** Vendors this tenant has flagged as sub-processors. */
        flaggedVendorCount: number;
        /** Declared primary→sub-processor relationships. */
        relationshipCount: number;
    };
    auditStream: {
        /** An external SIEM endpoint is configured for this tenant. */
        configured: boolean;
    };
    dsar: {
        /**
         * True — rights requests can be RECORDED and tracked in the admin
         * register (`/admin/dsar-requests`).
         */
        intakeEnabled: boolean;
        /**
         * False — fulfilment is MANUAL. The export bundle and erasure cascade
         * (docs/dsar.md Stage 2/3) are not built; both jobs throw and are
         * unregistered. Marking a request COMPLETED records that a human did
         * the work out-of-band. These two flags are separate precisely so the
         * page cannot imply execution just because intake exists.
         */
        automatedFulfilment: boolean;
        coolingOffHours: number;
        exportTtlDays: number;
    };
}

/**
 * Gather the tenant's privacy posture. Admin-gated, tenant-scoped, and free
 * of side effects.
 */
export async function getPrivacyPosture(ctx: RequestContext): Promise<PrivacyPosture> {
    assertCanViewAdminSettings(ctx);

    return runInTenantContext(ctx, async (db) => {
        const [tenant, securitySettings, evidenceWithRetentionRule, flaggedVendorCount, relationshipCount] =
            await Promise.all([
                db.tenant.findUnique({
                    where: { id: ctx.tenantId },
                    select: {
                        region: true,
                        encryptedDek: true,
                        previousEncryptedDek: true,
                    },
                }),
                db.tenantSecuritySettings.findUnique({
                    where: { tenantId: ctx.tenantId },
                    select: { auditStreamUrl: true },
                }),
                db.evidence.count({
                    where: { tenantId: ctx.tenantId, retentionPolicy: { not: 'NONE' } },
                }),
                db.vendor.count({
                    where: { tenantId: ctx.tenantId, isSubprocessor: true, deletedAt: null },
                }),
                db.vendorRelationship.count({ where: { tenantId: ctx.tenantId } }),
            ]);

        const region = tenant?.region ?? 'US_EAST_1';

        return {
            encryption: {
                perTenantDek: Boolean(tenant?.encryptedDek),
                rotationInFlight: Boolean(tenant?.previousEncryptedDek),
            },
            residency: {
                region,
                provisioned: isProvisionedRegion(region),
                // Hardcoded true rather than derived: production is
                // single-region by deployment, not by any queryable state, so
                // there is nothing to read that could make this false.
                declarativeOnly: true,
            },
            retention: {
                softDeleteGraceDays: DEFAULT_SOFT_DELETE_GRACE_DAYS,
                evidencePurgeDays: DEFAULT_EVIDENCE_PURGE_DAYS,
                tenantConfigurable: false,
                evidenceWithRetentionRule,
            },
            subProcessors: { flaggedVendorCount, relationshipCount },
            auditStream: { configured: Boolean(securitySettings?.auditStreamUrl) },
            dsar: {
                intakeEnabled: true,
                automatedFulfilment: false,
                coolingOffHours: DSAR_COOLING_OFF_HOURS,
                exportTtlDays: DSAR_EXPORT_TTL_DAYS,
            },
        };
    });
}
