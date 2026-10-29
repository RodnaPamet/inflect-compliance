/**
 * RQ-2 — daily risk-appetite breach monitor (cross-tenant fan-out).
 *
 * For every tenant with a RiskAppetiteConfig: scan the portfolio,
 * persist new breaches, resolve stale ones. Notifications for new
 * breaches ride the existing pipeline (logged here; wired in follow-up).
 *
 * @module jobs/risk-appetite-jobs
 */
import prisma from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';
import type { PermissionSet } from '@/lib/permissions';
import type { Permissions } from '@/lib/tenant-context';
import { borrowedJobActor, type BorrowFailure } from '@/app-layer/context-system';
import {
    checkPortfolioAppetite,
    recordBreaches,
    resolveStaleBreaches,
} from '@/app-layer/usecases/risk-appetite';
import { logger } from '@/lib/observability/logger';
import type { RiskAppetiteMonitorPayload } from './types';

/**
 * Whether a borrowed actor's RESOLVED authority lets this job do its work:
 * `checkPortfolioAppetite` asserts `assertCanRead`, which reads
 * `permissions.canRead`.
 *
 * One definition, read by the pick below, so the job can never choose a member
 * its own usecase would then refuse (#4388).
 */
export function mayRunAppetiteMonitor(authority: { permissions: Permissions; appPermissions: PermissionSet }): boolean {
    return authority.permissions.canRead === true;
}

/** Build a read-capable tenant context (first active admin/owner). */
async function buildCtx(
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
        allows: mayRunAppetiteMonitor,
    });
    if (!actor) return { ctx: null, reason };
    return {
        ctx: {
            requestId: `risk-appetite-${tenantId}`,
            userId: actor.userId,
            tenantId,
            role: actor.role,
            permissions: actor.permissions,
            appPermissions: actor.appPermissions,
        },
        reason: null,
    };
}

export async function runRiskAppetiteMonitor(_payload: RiskAppetiteMonitorPayload) {
    const configs = await prisma.riskAppetiteConfig.findMany({ select: { tenantId: true }, take: 5000 });
    let scanned = 0;
    let newBreaches = 0;
    let resolved = 0;
    let unroutable = 0;
    for (const { tenantId } of configs) {
        const { ctx, reason } = await buildCtx(tenantId);
        // A tenant with a configured appetite that this job cannot act in was
        // previously skipped in silence, so a workspace could stop being
        // monitored with nothing anywhere saying so (#4388).
        if (!ctx) {
            unroutable++;
            logger.warn('risk-appetite-monitor: no borrowable actor, tenant not scanned', {
                component: 'risk-appetite',
                tenantId,
                reason,
            });
            continue;
        }
        try {
            const result = await checkPortfolioAppetite(ctx);
            newBreaches += await recordBreaches(ctx, result.breaches);
            resolved += await resolveStaleBreaches(ctx, result.breaches);
            scanned++;
        } catch (err) {
            logger.warn('risk-appetite-monitor: tenant scan failed', {
                component: 'risk-appetite',
                tenantId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return { tenants: configs.length, scanned, unroutable, newBreaches, resolved };
}
