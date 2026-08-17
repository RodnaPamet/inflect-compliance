/**
 * identity-sync jobs (PR-2).
 *
 *   - `identity-sync`          — sync ONE Okta / Google Workspace / Entra ID / Active Directory connection.
 *   - `identity-sync-dispatch` — daily fan-out: enqueue a sync for every
 *                                enabled identity connection across tenants.
 *
 * The per-connection worker delegates to the tenant-scoped
 * `runIdentitySync` usecase (no global prisma there). The dispatcher reads
 * only connection ids (not tenant content) via global prisma, mirroring
 * `sharepoint-delta-sync-dispatch`.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { enqueue } from './queue';
import { runIdentitySync, type IdentitySyncResult } from '@/app-layer/usecases/identity-sync';
import type { IdentitySyncPayload } from './types';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import { fanOut, dispatchJobId, DAILY_BUCKET_MS } from './fan-out';
import { runInTenantContext } from '@/lib/db-context';
import { buildSystemContext } from '@/app-layer/context-system';
import { acquireSyncLock, releaseSyncLock } from '@/app-layer/integrations/connection-lock';

const IDENTITY_PROVIDERS = ['okta', 'google-workspace', 'entra-id', 'active-directory'];

export async function runIdentitySyncJob(payload: IdentitySyncPayload): Promise<IdentitySyncResult> {
    if (!payload.tenantId || !payload.connectionId) {
        throw new Error('identity-sync requires tenantId + connectionId');
    }
    // One sync at a time per connection. Two overlapping runs compute their
    // `seen` sets independently, and the deprovision reconcile from the run
    // that started EARLIER (`externalUserId: { notIn: seen }`) can flip accounts
    // the later run just upserted to DEPROVISIONED — the wrongful-mass-
    // deprovision hazard the truncation guard already worries about, arriving
    // through a different door.
    const ctx = buildSystemContext({ tenantId: payload.tenantId, job: 'identity-sync' });
    const token = await runInTenantContext(ctx, (db) =>
        acquireSyncLock(db, payload.connectionId!),
    );
    if (!token) {
        // Not a failure — another run is already doing exactly this work.
        return { executionId: '', status: 'SKIPPED', upserted: 0, deprovisioned: 0 };
    }

    try {
        // Returned whole rather than field-by-field. The old shim re-listed four
        // fields, so `errorMessage` and `noRetry` were silently dropped on the way
        // to the queue — the classification existed and never arrived.
        return await runIdentitySync({ tenantId: payload.tenantId, connectionId: payload.connectionId });
    } finally {
        // `finally`, so a throw releases the lock rather than wedging the
        // connection until the lease expires.
        await runInTenantContext(ctx, (db) =>
            releaseSyncLock(db, payload.connectionId!, token),
        );
    }
}

/** Fan-out: one identity-sync per enabled Okta / Google Workspace connection. */
export async function runIdentitySyncDispatch(): Promise<{ connections: number; dispatched: number; failed: number }> {
    // Was `take: 1000` with no signal. Past the cap, tenants never synced and
    // the completion log still read like a clean success.
    const connections = await drainPages((cursor) =>
        prisma.integrationConnection.findMany({
            where: { provider: { in: IDENTITY_PROVIDERS }, isEnabled: true },
            select: { id: true, tenantId: true },
            orderBy: { id: 'asc' },
            take: DRAIN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
    );

    // Deterministic id per (connection, UTC day) so a dispatcher retry or a
    // redeploy replaying the schedule cannot queue a second full sync for every
    // connection; failures isolated so one bad enqueue does not silently drop
    // every connection behind it.
    const { dispatched, failed } = await fanOut(
        connections,
        'identity-sync',
        (conn) => ({ tenantId: conn.tenantId, connectionId: conn.id }),
        (conn) =>
            enqueue(
                'identity-sync',
                { tenantId: conn.tenantId, connectionId: conn.id },
                { jobId: dispatchJobId('identity-sync', conn.id, DAILY_BUCKET_MS) },
            ),
    );

    logger.info('identity-sync-dispatch complete', { component: 'identity-sync', connections: connections.length, dispatched, failed });

    // Nothing got out at all — reporting success would claim a clean run that
    // dispatched nothing.
    if (failed > 0 && dispatched === 0) {
        throw new Error(`identity-sync-dispatch: all ${failed} enqueues failed`);
    }
    return { connections: connections.length, dispatched, failed };
}
