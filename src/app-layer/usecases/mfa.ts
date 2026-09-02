/**
 * MFA Policy Usecases
 *
 * Tenant-scoped MFA policy management:
 * - getTenantSecuritySettings: read current MFA policy
 * - updateTenantMfaPolicy: gated on `canAdmin`, so OWNER and ADMIN both —
 *   update MFA policy and session settings
 * - getUserMfaStatus: check if current user has MFA enrolled for current tenant
 */
import { prisma } from '@/lib/prisma';
import type { RequestContext } from '../types';
import type { UpdateMfaPolicyInputType } from '../schemas/mfa.schemas';
import type { MfaPolicy } from '@prisma/client';
import { forbidden, badRequest } from '@/lib/errors/types';

// ─── Types ──────────────────────────────────────────────────────────

export interface TenantSecuritySettingsResult {
    mfaPolicy: MfaPolicy;
    sessionMaxAgeMinutes: number | null;
}

export interface UserMfaStatusResult {
    isEnrolled: boolean;
    isVerified: boolean;
    enrolledAt: Date | null;
    verifiedAt: Date | null;
    tenantMfaPolicy: MfaPolicy;
    mfaRequired: boolean;
}

// ─── Get Tenant Security Settings ───────────────────────────────────

/**
 * Returns the current MFA policy and session settings for the tenant.
 * Returns defaults (DISABLED, null) if no settings record exists.
 */
export async function getTenantSecuritySettings(
    ctx: RequestContext,
): Promise<TenantSecuritySettingsResult> {
    const settings = await prisma.tenantSecuritySettings.findUnique({
        where: { tenantId: ctx.tenantId },
    });

    return {
        mfaPolicy: settings?.mfaPolicy ?? 'DISABLED',
        sessionMaxAgeMinutes: settings?.sessionMaxAgeMinutes ?? null,
    };
}

// ─── Update Tenant MFA Policy ───────────────────────────────────────

/**
 * Updates the MFA policy for the tenant. Gated on `canAdmin`, which is
 * `ROLE_ORDER[role] >= 4` — OWNER (5) and ADMIN (4), not ADMIN alone.
 * Creates the settings record if it doesn't exist.
 */
export async function updateTenantMfaPolicy(
    ctx: RequestContext,
    input: UpdateMfaPolicyInputType,
): Promise<TenantSecuritySettingsResult> {
    if (!ctx.permissions.canAdmin) {
        throw forbidden('Only admins can update MFA policy');
    }

    // ── Anti-lockout safeguard ───────────────────────────────────────
    // If switching to REQUIRED, verify at least one member who could switch
    // it BACK has MFA enrolled.
    //
    // The population is OWNER + ADMIN, and both halves are load-bearing.
    // `canAdmin` is `ROLE_ORDER[role] >= 4` (src/lib/tenant-context.ts), which
    // OWNER=5 satisfies — so an OWNER reaches this function, but a query
    // filtering `role: 'ADMIN'` cannot see one. That made the safeguard a
    // no-op on the DEFAULT tenant shape: `createTenantWithOwner` writes one
    // OWNER and no ADMIN, so the id list came back empty, the enrolment
    // count was skipped, and REQUIRED was accepted with nobody enrolled.
    //
    // The previous test suite pinned that as correct — "tenant with zero
    // ADMINs (no lockout possible) … no one to lock out". There is always
    // someone: the trigger in 20260424220000_epic1_last_owner_trigger raises
    // if any tenant would reach zero `role = 'OWNER' AND status = 'ACTIVE'`
    // rows, so every tenant has at least one active OWNER by construction.
    //
    // `status: 'ACTIVE'` because a DEACTIVATED or REMOVED member cannot sign
    // in, so their enrolment does not make the policy recoverable. INVITED
    // likewise — no session has ever existed.
    //
    // Not covered here: a custom role whose base `role` is below ADMIN but
    // whose `permissionsJson` grants admin rights. That lives on
    // `TenantCustomRole` and would need a join; the built-in roles are the
    // population this query can honestly express.
    if (input.mfaPolicy === 'REQUIRED') {
        const adminCapableMemberships = await prisma.tenantMembership.findMany({
            where: {
                tenantId: ctx.tenantId,
                role: { in: ['OWNER', 'ADMIN'] },
                status: 'ACTIVE',
            },
            select: { userId: true },
        });

        const adminCapableUserIds = adminCapableMemberships.map(m => m.userId);

        // Retained as a guard rather than relying on `{ in: [] }` counting
        // zero. It should now be unreachable — the trigger above guarantees
        // an active OWNER — so reaching it means that invariant broke, and
        // skipping the count is the same answer the old code gave.
        if (adminCapableUserIds.length > 0) {
            const enrolledAdminCapableCount = await prisma.userMfaEnrollment.count({
                where: {
                    userId: { in: adminCapableUserIds },
                    tenantId: ctx.tenantId,
                    type: 'TOTP',
                    isVerified: true,
                },
            });

            if (enrolledAdminCapableCount === 0) {
                throw badRequest(
                    'Cannot enable REQUIRED MFA: at least one active owner or admin must be ' +
                    'enrolled in MFA first. Please set up MFA for your account before enabling ' +
                    'this policy.',
                );
            }
        }
    }

    const settings = await prisma.tenantSecuritySettings.upsert({
        where: { tenantId: ctx.tenantId },
        create: {
            tenantId: ctx.tenantId,
            mfaPolicy: input.mfaPolicy as MfaPolicy,
            sessionMaxAgeMinutes: input.sessionMaxAgeMinutes ?? null,
        },
        update: {
            mfaPolicy: input.mfaPolicy as MfaPolicy,
            sessionMaxAgeMinutes: input.sessionMaxAgeMinutes ?? null,
        },
    });

    return {
        mfaPolicy: settings.mfaPolicy,
        sessionMaxAgeMinutes: settings.sessionMaxAgeMinutes,
    };
}


// ─── Get User MFA Status ────────────────────────────────────────────

/**
 * Returns the MFA enrollment status for the current user in the current tenant.
 * Includes whether MFA is required based on tenant policy.
 */
export async function getUserMfaStatus(
    ctx: RequestContext,
): Promise<UserMfaStatusResult> {
    const [enrollment, settings] = await Promise.all([
        prisma.userMfaEnrollment.findUnique({
            where: {
                userId_tenantId_type: {
                    userId: ctx.userId,
                    tenantId: ctx.tenantId,
                    type: 'TOTP',
                },
            },
        }),
        prisma.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
        }),
    ]);

    const policy = settings?.mfaPolicy ?? 'DISABLED';

    return {
        isEnrolled: !!enrollment,
        isVerified: enrollment?.isVerified ?? false,
        enrolledAt: enrollment?.createdAt ?? null,
        verifiedAt: enrollment?.verifiedAt ?? null,
        tenantMfaPolicy: policy,
        mfaRequired: policy === 'REQUIRED',
    };
}
