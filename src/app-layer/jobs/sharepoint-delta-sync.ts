/**
 * SP-3 — SharePoint delta-sync BullMQ jobs.
 *
 *   - `sharepoint-delta-sync`          — sync one connection (manual or scheduled).
 *   - `sharepoint-delta-sync-dispatch` — daily fan-out: enqueue a per-connection
 *     sync for every enabled SharePoint connection across all tenants.
 *
 * @module jobs/sharepoint-delta-sync
 */
import prisma from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { runSharePointDeltaSync } from '@/app-layer/integrations/providers/sharepoint/import';
import { enqueue } from './queue';
import { logger } from '@/lib/observability/logger';
import type { SharePointDeltaSyncPayload, SharePointDeltaSyncDispatchPayload } from './types';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';

/** Build a tenant RequestContext for a job actor (an active member). */
async function buildJobContext(tenantId: string, actorUserId: string): Promise<RequestContext> {
    const membership = await prisma.tenantMembership.findFirst({
        where: { userId: actorUserId, tenantId, status: 'ACTIVE' },
        select: { role: true },
    });
    if (!membership) {
        throw new Error(`sharepoint-delta-sync: user ${actorUserId} is not an active member of tenant ${tenantId}`);
    }
    const appPermissions = getPermissionsForRole(membership.role);
    return {
        requestId: `sharepoint-delta-sync-${tenantId}`,
        userId: actorUserId,
        tenantId,
        role: membership.role,
        permissions: {
            canRead: appPermissions.evidence.view,
            canWrite: appPermissions.evidence.upload,
            canAdmin: appPermissions.admin.manage,
            canAudit: appPermissions.audits.view,
            canExport: appPermissions.reports.export,
        },
        appPermissions,
    };
}

export async function runSharePointDeltaSyncJob(payload: SharePointDeltaSyncPayload) {
    const ctx = await buildJobContext(payload.tenantId, payload.actorUserId);
    if (!ctx.permissions.canWrite) {
        throw new Error(`sharepoint-delta-sync: actor lacks evidence.upload on tenant ${payload.tenantId}`);
    }
    return runSharePointDeltaSync(ctx, payload.connectionId);
}

/**
 * Fan-out: one delta-sync job per enabled SharePoint connection. Picks an
 * active OWNER/ADMIN of each tenant as the actor (re-imports need evidence
 * write). Connections with no eligible admin are skipped (logged).
 */
export async function runSharePointDeltaSyncDispatch(_payload: SharePointDeltaSyncDispatchPayload) {
    // Was `take: 1000` with no signal, and this dispatcher had no completion
    // log at all — so its truncation was even less observable than the other
    // two. See ./drain-pages.
    const connections = await drainPages((cursor) =>
        prisma.integrationConnection.findMany({
            where: { provider: 'sharepoint', isEnabled: true },
            select: { id: true, tenantId: true },
            orderBy: { id: 'asc' },
            take: DRAIN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
    );

    // Hoist the actor lookup out of the per-connection loop (avoid N+1): one
    // query for all eligible admins, keyed to the oldest per tenant.
    const tenantIds = [...new Set(connections.map((c) => c.tenantId))];
    // `distinct` rather than a cap, because the cap here did not merely drop
    // rows — it produced a WRONG DIAGNOSIS. The old query ordered by createdAt
    // GLOBALLY across every tenant and took 5000, so a tenant whose
    // memberships all sort late contributed zero rows, fell out of
    // `adminByTenant`, and was logged below as "no eligible admin". That
    // tenant has admins; the query just never returned them, and the warning
    // sent an operator looking for a membership problem that does not exist.
    //
    // One row per tenant is all this needs, so ask for exactly that: order by
    // (tenantId, createdAt) and take the first per tenantId. Bounded by the
    // tenant count, which is bounded by `connections` — no cap required.
    const admins = await prisma.tenantMembership.findMany({
        where: { tenantId: { in: tenantIds }, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
        select: { tenantId: true, userId: true },
        orderBy: [{ tenantId: 'asc' }, { createdAt: 'asc' }],
        distinct: ['tenantId'],
    });
    const adminByTenant = new Map<string, string>();
    for (const a of admins) if (!adminByTenant.has(a.tenantId)) adminByTenant.set(a.tenantId, a.userId);

    let dispatched = 0;
    for (const conn of connections) {
        const actorUserId = adminByTenant.get(conn.tenantId);
        if (!actorUserId) {
            logger.warn('sharepoint-delta-sync-dispatch: no eligible admin', {
                component: 'sharepoint',
                tenantId: conn.tenantId,
                connectionId: conn.id,
            });
            continue;
        }
        await enqueue('sharepoint-delta-sync', {
            tenantId: conn.tenantId,
            connectionId: conn.id,
            actorUserId,
            triggeredBy: 'scheduled',
        });
        dispatched++;
    }
    // This dispatcher had no completion log at all. `connections` and
    // `dispatched` differ whenever a tenant is skipped for want of an admin,
    // and that gap is the thing worth seeing.
    logger.info('sharepoint-delta-sync-dispatch complete', {
        component: 'sharepoint',
        connections: connections.length,
        dispatched,
        skippedNoAdmin: connections.length - dispatched,
    });
    return { connections: connections.length, dispatched };
}
