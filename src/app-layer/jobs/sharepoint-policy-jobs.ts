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
import { borrowedJobActor, BORROW_FAILURE, type BorrowFailure } from '@/app-layer/context-system';
import {
    pullPolicyFromSharePoint,
    getSharePointClientForTenant,
} from '@/app-layer/usecases/policy-sharepoint-sync';
import { logger } from '@/lib/observability/logger';
import type { SharePointPolicyPullPayload, SharePointSubscriptionRenewPayload } from './types';

/**
 * Whether a borrowed actor's RESOLVED authority lets this job do its work:
 * a pull WRITES the policy's content. `pullPolicyFromSharePoint` itself
 * asserts nothing, but its user-facing twin `pullPolicyByIdFromSharePoint`
 * asserts `assertCanWrite`, so that is the authority this work needs.
 *
 * One definition, read by the pick below, so the job can never choose a member
 * its own usecase would then refuse (#4388).
 */
export function mayPullPolicyFromSharePoint(authority: { permissions: Permissions; appPermissions: PermissionSet }): boolean {
    return authority.permissions.canWrite === true;
}

/** Build a write-capable tenant context for a job actor (first active admin). */
async function buildPolicyJobContext(
    tenantId: string,
): Promise<{ ctx: RequestContext; reason: null } | { ctx: null; reason: BorrowFailure }> {
    // The actor is the first member IN ORDER whose resolved authority allows
    // this job's work -- custom role included. It used to be the oldest
    // OWNER/ADMIN with `getPermissionsForRole(role)`, which dropped the custom
    // role, and the coarse flags were hand-projected from granular ones rather
    // than computed from the role (#4388).
    const { actor, reason } = await borrowedJobActor({
        tenantId,
        roles: ['OWNER', 'ADMIN'],
        orderBy: 'createdAt',
        allows: mayPullPolicyFromSharePoint,
    });
    if (!actor) return { ctx: null, reason };
    return {
        ctx: {
            requestId: `sharepoint-policy-${tenantId}`,
            userId: actor.userId,
            tenantId,
            role: actor.role,
            permissions: actor.permissions,
            appPermissions: actor.appPermissions,
        },
        reason: null,
    };
}

export async function runSharePointPolicyPull(payload: SharePointPolicyPullPayload) {
    const { ctx, reason } = await buildPolicyJobContext(payload.tenantId);
    // `no_admin` is kept for an empty tenant so the existing result contract
    // does not move; a tenant whose members are all locked out of this work is
    // a DIFFERENT fact and gets its own reason rather than that one (#4388).
    if (!ctx) {
        return {
            pulled: false,
            reason: reason === BORROW_FAILURE.NO_ACTIVE_MEMBER ? 'no_admin' : 'no_qualifying_actor',
        };
    }
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
    // Cache one client per tenant (avoid rebuilding the token per policy).
    const clientByTenant = new Map<string, Awaited<ReturnType<typeof getSharePointClientForTenant>> | null>();
    for (const p of policies) {
        if (!p.spSubscriptionId) continue;
        let client = clientByTenant.get(p.tenantId);
        if (client === undefined) {
            const { ctx, reason } = await buildPolicyJobContext(p.tenantId);
            if (!ctx) {
                // Renewal stops for this tenant's subscriptions; say why once
                // per tenant rather than dropping them silently (#4388).
                logger.warn('sharepoint-subscription-renew: no borrowable actor, tenant skipped', {
                    component: 'sharepoint',
                    tenantId: p.tenantId,
                    reason,
                });
            }
            client = ctx ? await getSharePointClientForTenant(ctx).catch(() => null) : null;
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
    return { subscriptions: policies.length, renewed };
}
