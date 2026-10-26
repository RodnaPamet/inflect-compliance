/**
 * SP-4 — SharePoint policy-sync BullMQ jobs.
 *
 *   - `sharepoint-policy-pull`         — enqueued by the Graph webhook: create a
 *     new PolicyVersion from the changed SharePoint file.
 *   - `sharepoint-subscription-renew`  — daily cron: renew every active policy
 *     Graph subscription before it expires (cross-tenant fan-out).
 *
 * @module jobs/sharepoint-policy-jobs
 */
import prisma from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';
import type { PermissionSet } from '@/lib/permissions';
import type { Permissions } from '@/lib/tenant-context';
import { borrowedMemberAuthority } from '@/app-layer/context-system';
import {
    pullPolicyFromSharePoint,
    getSharePointClientForTenant,
} from '@/app-layer/usecases/policy-sharepoint-sync';
import { logger } from '@/lib/observability/logger';
import type { SharePointPolicyPullPayload, SharePointSubscriptionRenewPayload } from './types';

/**
 * Whether a member's resolved authority lets them act for the policy sync: the
 * key the link, unlink and manual-pull routes ask (`policies.edit`), with the
 * coarse write flag, because a pull writes a policy version and
 * `assertCanWritePolicies` refuses without both. A renewal keeps alive the
 * subscription that `policies.edit` created. One definition, read when the
 * actor is chosen, so neither job acts as a member the pull would refuse.
 */
export function mayRunPolicySync(authority: {
    permissions: Permissions;
    appPermissions: PermissionSet;
}): boolean {
    return authority.permissions.canWrite && authority.appPermissions.policies.edit === true;
}

/** Why a policy-sync job had nobody to act as. Each is logged and returned in the job's result. */
export const POLICY_SYNC_UNROUTABLE = {
    /** The tenant has no ACTIVE OWNER or ADMIN membership at all. */
    NO_ACTIVE_ADMIN: 'no_admin',
    /** It has some, but every one's resolved permissions withhold `policies.edit`. */
    NO_ADMIN_WITH_POLICY_EDIT: 'no_admin_with_policy_edit',
} as const;
export type PolicySyncUnroutableReason = (typeof POLICY_SYNC_UNROUTABLE)[keyof typeof POLICY_SYNC_UNROUTABLE];

/** The coarse flags these jobs have always projected for a built-in role. */
function builtInCoarseFlags(appPermissions: PermissionSet): Permissions {
    return {
        canRead: appPermissions.policies.view,
        canWrite: appPermissions.policies.edit,
        canAdmin: appPermissions.admin.manage,
        canAudit: appPermissions.audits.view,
        canExport: appPermissions.reports.export,
    };
}

/**
 * Build a write-capable tenant context for a job actor: the oldest active
 * OWNER/ADMIN whose resolved authority, custom role included (#4388), passes
 * `mayRunPolicySync`. An admin whose custom role withholds `policies.edit` is
 * passed over for the next one. Exported for its test.
 */
export async function buildPolicyJobContext(
    tenantId: string,
): Promise<{ ok: true; ctx: RequestContext } | { ok: false; reason: PolicySyncUnroutableReason }> {
    // Uncapped: one tenant's OWNER/ADMIN memberships. A cap could leave out the
    // member who qualifies and report the tenant as having nobody.
    const admins = await prisma.tenantMembership.findMany({
        where: { tenantId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
        select: {
            userId: true,
            role: true,
            customRole: { select: { baseRole: true, permissionsJson: true } },
        },
        orderBy: { createdAt: 'asc' },
    });
    if (admins.length === 0) return { ok: false, reason: POLICY_SYNC_UNROUTABLE.NO_ACTIVE_ADMIN };
    for (const admin of admins) {
        const authority = borrowedMemberAuthority(admin, builtInCoarseFlags);
        if (!mayRunPolicySync(authority)) continue;
        return {
            ok: true,
            ctx: {
                requestId: `sharepoint-policy-${tenantId}`,
                userId: admin.userId,
                tenantId,
                ...authority,
            },
        };
    }
    return { ok: false, reason: POLICY_SYNC_UNROUTABLE.NO_ADMIN_WITH_POLICY_EDIT };
}

function warnUnroutable(job: string, tenantId: string, reason: PolicySyncUnroutableReason): void {
    logger.warn(`${job}: no admin to act as`, { component: 'sharepoint', tenantId, reason });
}

export async function runSharePointPolicyPull(payload: SharePointPolicyPullPayload) {
    const actor = await buildPolicyJobContext(payload.tenantId);
    if (!actor.ok) {
        warnUnroutable('sharepoint-policy-pull', payload.tenantId, actor.reason);
        return { pulled: false, reason: actor.reason };
    }
    const ctx = actor.ctx;
    const policy = await prisma.policy.findFirst({
        where: { id: payload.policyId, tenantId: payload.tenantId },
        select: { spDriveId: true, spItemId: true },
    });
    if (!policy?.spDriveId || !policy.spItemId) return { pulled: false, reason: 'not_linked' };
    const r = await pullPolicyFromSharePoint(ctx, { driveId: policy.spDriveId, itemId: policy.spItemId });
    return { pulled: r.pulled };
}

const RENEW_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export async function runSharePointSubscriptionRenew(_payload: SharePointSubscriptionRenewPayload) {
    const policies = await prisma.policy.findMany({
        where: { spSubscriptionId: { not: null } },
        select: { id: true, tenantId: true, spSubscriptionId: true },
        take: 5000,
    });
    let renewed = 0;
    // A tenant whose subscriptions were skipped because it had nobody to act
    // as. They were skipped in silence, and expire within two days unrenewed.
    const unroutable: Array<{ tenantId: string; reason: PolicySyncUnroutableReason }> = [];
    // Cache one client per tenant (avoid rebuilding the token per policy).
    const clientByTenant = new Map<string, Awaited<ReturnType<typeof getSharePointClientForTenant>> | null>();
    for (const p of policies) {
        if (!p.spSubscriptionId) continue;
        let client = clientByTenant.get(p.tenantId);
        if (client === undefined) {
            const actor = await buildPolicyJobContext(p.tenantId);
            if (!actor.ok) {
                unroutable.push({ tenantId: p.tenantId, reason: actor.reason });
                warnUnroutable('sharepoint-subscription-renew', p.tenantId, actor.reason);
            }
            client = actor.ok ? await getSharePointClientForTenant(actor.ctx).catch(() => null) : null;
            clientByTenant.set(p.tenantId, client);
        }
        if (!client) continue;
        try {
            await client.renewSubscription(p.spSubscriptionId, new Date(Date.now() + RENEW_TTL_MS).toISOString());
            renewed++;
        } catch (err) {
            logger.warn('sharepoint-subscription-renew: renew failed', {
                component: 'sharepoint',
                tenantId: p.tenantId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return { subscriptions: policies.length, renewed, unroutable };
}
