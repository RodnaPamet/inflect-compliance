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
import {
    initiatorAuthority,
    resolveInitiatorContext,
    resolveKeyInitiatorContext,
} from '@/app-layer/context-system';
import type { PermissionSet } from '@/lib/permissions';
import { runSharePointDeltaSync } from '@/app-layer/integrations/providers/sharepoint/import';
import { enqueue } from './queue';
import { fanOut, dispatchJobId, FOUR_HOURLY_BUCKET_MS } from './fan-out';
import { logger } from '@/lib/observability/logger';
import type { SharePointDeltaSyncPayload, SharePointDeltaSyncDispatchPayload } from './types';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import { runInTenantContext } from '@/lib/db-context';
import { acquireSyncLock, releaseSyncLock } from '@/app-layer/integrations/connection-lock';
import { markSyncBlocked, clearSyncBlocked } from '@/app-layer/integrations/connection-health';

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
 *
 * A sync requested with an API KEY runs as that key AND its user
 * (`resolveKeyInitiatorContext`, the shape #4382 settled for the evidence
 * import). The route checked the key — its scopes, its tenant, its liveness —
 * and then queued a job that rebuilt the user's WHOLE membership, so a key
 * holding `evidence:write` and nothing else had the sync run with everything
 * its creator may do, and a key revoked while the job waited did not stop it
 * (#4386). The key is read again here, by id, and the job holds the
 * conjunction: never more than either term.
 *
 * A payload with no key id runs as the member, unchanged. That covers a session
 * request, EVERY scheduled run — the dispatcher borrows a member and no key is
 * involved — and any payload queued before the route carried the id.
 */
async function buildJobContext(payload: SharePointDeltaSyncPayload): Promise<RequestContext> {
    const { tenantId, actorUserId } = payload;
    const requestId = payload.requestId ?? `sharepoint-delta-sync-${tenantId}`;

    if (payload.apiKeyId) {
        const resolved = await resolveKeyInitiatorContext({
            tenantId,
            userId: actorUserId,
            apiKeyId: payload.apiKeyId,
            requestId,
        });
        if (!resolved.ok) {
            // Named, because an operator has to tell a revoked key from a key
            // belonging to somebody else, and the job does no work either way.
            throw new Error(
                `sharepoint-delta-sync: API key ${payload.apiKeyId} that started this sync is refused (${resolved.reason}) on tenant ${tenantId}`,
            );
        }
        return resolved.ctx;
    }

    const ctx = await resolveInitiatorContext({ tenantId, userId: actorUserId, requestId });
    if (!ctx) {
        throw new Error(`sharepoint-delta-sync: user ${actorUserId} is not an active member of tenant ${tenantId}`);
    }
    return ctx;
}

export async function runSharePointDeltaSyncJob(payload: SharePointDeltaSyncPayload) {
    const ctx = await buildJobContext(payload);
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

    // Record the block ON THE CONNECTION, which is the only place an admin
    // looks. The dispatch result and the warn line above are read by neither
    // (#4389). Marked per reason so the two stay distinguishable, and the first
    // observation is the one whose timestamp sticks.
    for (const reason of Object.values(DELTA_SYNC_UNROUTABLE)) {
        await markSyncBlocked(
            prisma,
            unroutable.filter((u) => u.reason === reason).map((u) => u.connectionId),
            reason,
        );
    }
    // Cleared on being ROUTABLE, not on being dispatched: the block records
    // "nobody may run this", and an eligible actor existing is exactly what
    // falsifies it. A throwing enqueue is a different failure with its own
    // counter, and letting it hold this banner up would blame a Redis outage on
    // a permissions configuration.
    await clearSyncBlocked(
        prisma,
        routable.map((c) => c.id),
    );

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
