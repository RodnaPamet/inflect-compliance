/**
 * hris-sync jobs (PR-4).
 *
 *   - `hris-sync`          — sync ONE HRIS connection's roster, under a
 *                            per-connection lock (see the note on it).
 *   - `hris-sync-dispatch` — daily fan-out: enqueue a sync per enabled HRIS
 *                            connection across tenants.
 *
 * The worker delegates to the tenant-scoped `runHrisSync` usecase. The
 * dispatcher reads only connection ids via global prisma (SharePoint pattern).
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { buildSystemContext } from '@/app-layer/context-system';
import { runInTenantContext } from '@/lib/db-context';
import { acquireSyncLock, releaseSyncLock } from '@/app-layer/integrations/connection-lock';
import { enqueue } from './queue';
import { runHrisSync, type HrisSyncResult } from '@/app-layer/usecases/hris-sync';
import type { HrisSyncPayload } from './types';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import { fanOut, dispatchJobId, DAILY_BUCKET_MS } from './fan-out';
// One list, shared with usecases/hris-sync — see the note on its declaration.
import { HRIS_PROVIDERS } from '../integrations/providers/hris';

export async function runHrisSyncJob(payload: HrisSyncPayload): Promise<HrisSyncResult> {
    if (!payload.tenantId || !payload.connectionId) throw new Error('hris-sync requires tenantId + connectionId');

    // ONE SYNC AT A TIME PER CONNECTION. identity-sync and sharepoint-delta-sync
    // both take this lock; hris-sync never did.
    //
    // Before resume that cost duplicate upserts. Now it corrupts pass state,
    // because two overlapping runs share `syncCursor` and `syncPassStartedAt`.
    // A manual re-run racing the scheduled one, or a queue retry after a worker
    // restart, is enough: if run A completes the pass it CLEARS both columns and
    // runs the departure reconcile against its own passStartedAt — terminating
    // every employee whose syncedAt predates it, INCLUDING the ones run B has
    // not reached yet. B then upserts them back to ACTIVE.
    //
    // The visible result is employees flipping to TERMINATED and back, which is
    // the wrongful-mass-termination hazard this whole area is built around,
    // arriving through the door identity-sync already closed.
    const ctx = buildSystemContext({ tenantId: payload.tenantId, job: 'hris-sync' });
    const token = await runInTenantContext(ctx, (db) => acquireSyncLock(db, payload.connectionId!));
    if (!token) {
        // Not a failure — another run is already doing exactly this work.
        // SKIPPED rather than PASSED, for the same reason PARTIAL is not
        // PASSED: nothing was reconciled, and a green status here would make a
        // contended connection indistinguishable from a synced one in the logs
        // someone reads to ask why an employee still shows as active.
        return { executionId: '', status: 'SKIPPED', upserted: 0, managersLinked: 0 };
    }

    try {
        // Whole result — a field-by-field shim drops errorMessage/noRetry silently.
        return await runHrisSync({ tenantId: payload.tenantId, connectionId: payload.connectionId });
    } finally {
        // `finally`, so a throw releases the lock rather than wedging the
        // connection until the lease expires.
        await runInTenantContext(ctx, (db) => releaseSyncLock(db, payload.connectionId!, token));
    }
}

export async function runHrisSyncDispatch(): Promise<{ connections: number; dispatched: number; failed: number }> {
    // Was `take: 1000` with no signal — see ./drain-pages.
    const connections = await drainPages((cursor) =>
        prisma.integrationConnection.findMany({
            where: { provider: { in: [...HRIS_PROVIDERS] }, isEnabled: true },
            select: { id: true, tenantId: true },
            orderBy: { id: 'asc' },
            take: DRAIN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
    );
    // Deterministic id per (connection, UTC day) + isolated failures — see
    // ./fan-out for why the two defects compound.
    const { dispatched, failed } = await fanOut(
        connections,
        'hris-sync',
        (conn) => ({ tenantId: conn.tenantId, connectionId: conn.id }),
        (conn) =>
            enqueue(
                'hris-sync',
                { tenantId: conn.tenantId, connectionId: conn.id },
                { jobId: dispatchJobId('hris-sync', conn.id, DAILY_BUCKET_MS) },
            ),
    );

    logger.info('hris-sync-dispatch complete', { component: 'hris-sync', connections: connections.length, dispatched, failed });

    if (failed > 0 && dispatched === 0) {
        throw new Error(`hris-sync-dispatch: all ${failed} enqueues failed`);
    }
    return { connections: connections.length, dispatched, failed };
}
