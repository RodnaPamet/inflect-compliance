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
import { fanOut, dispatchJobId, FOUR_HOURLY_BUCKET_MS } from './fan-out';
import { logger } from '@/lib/observability/logger';
import type { SharePointDeltaSyncPayload, SharePointDeltaSyncDispatchPayload } from './types';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import { runInTenantContext } from '@/lib/db-context';
import { acquireSyncLock, releaseSyncLock } from '@/app-layer/integrations/connection-lock';

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

    // One delta sync at a time per connection. Two concurrent runs replay the
    // same change set from the same delta token and each create a FRESH
    // Evidence row for every changed file — only the mapping is upserted — so
    // the duplicate is left orphaned, with no provenance back to the drive.
    // Reachable by double-clicking "Sync now". See integrations/connection-lock.
    const token = await runInTenantContext(ctx, (db) =>
        acquireSyncLock(db, payload.connectionId),
    );
    if (!token) {
        // Not a failure: another run is already doing exactly this work.
        return { drivesSynced: 0, reimported: 0, staled: 0, skipped: 'sync_already_running' as const };
    }

    try {
        return await runSharePointDeltaSync(ctx, payload.connectionId);
    } finally {
        // `finally`, so a throw releases the lock rather than wedging the
        // connection until the lease expires.
        await runInTenantContext(ctx, (db) =>
            releaseSyncLock(db, payload.connectionId, token),
        );
    }
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

    const routable = connections.filter((conn) => {
        if (adminByTenant.has(conn.tenantId)) return true;
        logger.warn('sharepoint-delta-sync-dispatch: no eligible admin', {
            component: 'sharepoint',
            tenantId: conn.tenantId,
            connectionId: conn.id,
        });
        return false;
    });

    // FOUR-hourly bucket, not daily — this dispatcher runs `0 */4 * * *`, and a
    // 24 h bucket would dedupe five of the six daily runs into a silent no-op.
    // See ./fan-out: an over-coarse bucket does not duplicate work, it stops it.
    const { dispatched, failed } = await fanOut(
        routable,
        'sharepoint',
        (conn) => ({ tenantId: conn.tenantId, connectionId: conn.id }),
        (conn) =>
            enqueue(
                'sharepoint-delta-sync',
                {
                    tenantId: conn.tenantId,
                    connectionId: conn.id,
                    actorUserId: adminByTenant.get(conn.tenantId)!,
                    triggeredBy: 'scheduled',
                },
                {
                    jobId: dispatchJobId(
                        'sharepoint-delta-sync',
                        conn.id,
                        FOUR_HOURLY_BUCKET_MS,
                    ),
                },
            ),
    );
    // This dispatcher had no completion log at all. The three ways a
    // connection fails to get a job are now distinguishable: no eligible admin,
    // a throwing enqueue, or simply not being there.
    logger.info('sharepoint-delta-sync-dispatch complete', {
        component: 'sharepoint',
        connections: connections.length,
        dispatched,
        failed,
        // Derived from `routable`, NOT from `dispatched` — subtracting the
        // dispatched count would relabel every enqueue failure as a
        // missing-admin skip and hide the Redis problem behind a config one.
        skippedNoAdmin: connections.length - routable.length,
    });

    if (failed > 0 && dispatched === 0) {
        throw new Error(`sharepoint-delta-sync-dispatch: all ${failed} enqueues failed`);
    }
    return { connections: connections.length, dispatched, failed };
}
