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
import { initiatorAuthority, resolveInitiatorContext } from '@/app-layer/context-system';
import type { PermissionSet } from '@/lib/permissions';
import { runSharePointDeltaSync } from '@/app-layer/integrations/providers/sharepoint/import';
import { enqueue } from './queue';
import { fanOut, dispatchJobId, FOUR_HOURLY_BUCKET_MS } from './fan-out';
import { logger } from '@/lib/observability/logger';
import type { SharePointDeltaSyncPayload, SharePointDeltaSyncDispatchPayload } from './types';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import { runInTenantContext } from '@/lib/db-context';
import { acquireSyncLock, releaseSyncLock } from '@/app-layer/integrations/connection-lock';

/**
 * Whether a member's resolved permissions let them run a delta sync: the key
 * the "Sync now" route asks (`requirePermission('evidence.upload')`), because a
 * re-import writes evidence. One definition, read by the job's own gate and by
 * the dispatcher choosing a scheduled run's actor, so the dispatcher never
 * picks a member the job would then refuse.
 */
export function mayRunDeltaSync(appPermissions: PermissionSet): boolean {
    return appPermissions.evidence.upload === true;
}

/**
 * Why the dispatcher could not queue a scheduled sync for a connection. Each is
 * logged with the connection and returned in the run's result.
 */
export const DELTA_SYNC_UNROUTABLE = {
    /** The tenant has no ACTIVE OWNER or ADMIN membership at all. */
    NO_ACTIVE_ADMIN: 'NO_ACTIVE_ADMIN',
    /** It has some, but every one's resolved permissions withhold `evidence.upload`. */
    NO_ADMIN_WITH_EVIDENCE_UPLOAD: 'NO_ADMIN_WITH_EVIDENCE_UPLOAD',
} as const;
export type DeltaSyncUnroutableReason = keyof typeof DELTA_SYNC_UNROUTABLE;

/**
 * Build a tenant RequestContext for a job actor (an active member): the same
 * authority a request from them gets, custom role included (#4362). For a
 * manual sync the actor is whoever clicked "Sync now"; for a scheduled one it
 * is the member the dispatcher below picked.
 */
async function buildJobContext(tenantId: string, actorUserId: string): Promise<RequestContext> {
    const ctx = await resolveInitiatorContext({
        tenantId,
        userId: actorUserId,
        requestId: `sharepoint-delta-sync-${tenantId}`,
    });
    if (!ctx) {
        throw new Error(`sharepoint-delta-sync: user ${actorUserId} is not an active member of tenant ${tenantId}`);
    }
    return ctx;
}

export async function runSharePointDeltaSyncJob(payload: SharePointDeltaSyncPayload) {
    const ctx = await buildJobContext(payload.tenantId, payload.actorUserId);
    // The key the "Sync now" route asks, not the coarse tier, which a custom
    // role can hold without it.
    if (!mayRunDeltaSync(ctx.appPermissions)) {
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
 * Fan-out: one delta-sync job per enabled SharePoint connection. The actor of
 * each tenant's scheduled sync is its oldest active OWNER/ADMIN whose RESOLVED
 * permissions — custom role included, through `initiatorAuthority`, the rule a
 * request resolves by — let them run one (`mayRunDeltaSync`). A connection
 * with no such member is not queued; it is logged and returned with its
 * `DELTA_SYNC_UNROUTABLE` reason.
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
    // query for every active OWNER/ADMIN of these tenants, oldest first.
    //
    // Not `distinct: ['tenantId']` any more, because the first membership per
    // tenant is no longer necessarily the actor: an ADMIN whose custom role
    // withholds `evidence.upload` is passed over for the next one (#4362). It
    // is still uncapped, and for the reason `distinct` replaced a cap: the old
    // global `take: 5000` dropped every membership of a tenant that sorted
    // late, and the tenant was then logged as having no eligible admin when it
    // had several. Bounded by the OWNER/ADMIN count of tenants that hold a
    // SharePoint connection.
    const tenantIds = [...new Set(connections.map((c) => c.tenantId))];
    const admins = await prisma.tenantMembership.findMany({
        where: { tenantId: { in: tenantIds }, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
        select: {
            tenantId: true,
            userId: true,
            role: true,
            customRole: { select: { baseRole: true, permissionsJson: true } },
        },
        orderBy: [{ tenantId: 'asc' }, { createdAt: 'asc' }],
    });
    const adminByTenant = new Map<string, string>();
    const tenantsWithAdmins = new Set<string>();
    for (const a of admins) {
        tenantsWithAdmins.add(a.tenantId);
        if (adminByTenant.has(a.tenantId)) continue;
        if (mayRunDeltaSync(initiatorAuthority(a).appPermissions)) adminByTenant.set(a.tenantId, a.userId);
    }

    const unroutable: Array<{ tenantId: string; connectionId: string; reason: DeltaSyncUnroutableReason }> = [];
    const routable = connections.filter((conn) => {
        if (adminByTenant.has(conn.tenantId)) return true;
        const reason: DeltaSyncUnroutableReason = tenantsWithAdmins.has(conn.tenantId)
            ? DELTA_SYNC_UNROUTABLE.NO_ADMIN_WITH_EVIDENCE_UPLOAD
            : DELTA_SYNC_UNROUTABLE.NO_ACTIVE_ADMIN;
        unroutable.push({ tenantId: conn.tenantId, connectionId: conn.id, reason });
        logger.warn('sharepoint-delta-sync-dispatch: connection not dispatched', {
            component: 'sharepoint',
            tenantId: conn.tenantId,
            connectionId: conn.id,
            reason,
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
    // This dispatcher had no completion log at all. The ways a connection fails
    // to get a job are now distinguishable: each `DELTA_SYNC_UNROUTABLE`
    // reason, a throwing enqueue, or simply not being there.
    const unroutableByReason = countByReason(unroutable);
    logger.info('sharepoint-delta-sync-dispatch complete', {
        component: 'sharepoint',
        connections: connections.length,
        dispatched,
        failed,
        // Derived from `routable`, NOT from `dispatched` — subtracting the
        // dispatched count would relabel every enqueue failure as a
        // missing-admin skip and hide the Redis problem behind a config one.
        unroutable: unroutable.length,
        ...unroutableByReason,
    });

    if (failed > 0 && dispatched === 0) {
        throw new Error(`sharepoint-delta-sync-dispatch: all ${failed} enqueues failed`);
    }
    return { connections: connections.length, dispatched, failed, unroutable };
}

function countByReason(
    rows: ReadonlyArray<{ reason: DeltaSyncUnroutableReason }>,
): Record<DeltaSyncUnroutableReason, number> {
    const out: Record<DeltaSyncUnroutableReason, number> = {
        NO_ACTIVE_ADMIN: 0,
        NO_ADMIN_WITH_EVIDENCE_UPLOAD: 0,
    };
    for (const r of rows) out[r.reason] += 1;
    return out;
}
