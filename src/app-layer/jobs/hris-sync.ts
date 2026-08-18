/**
 * hris-sync jobs (PR-4).
 *
 *   - `hris-sync`          — sync ONE BambooHR connection's roster.
 *   - `hris-sync-dispatch` — daily fan-out: enqueue a sync per enabled HRIS
 *                            connection across tenants.
 *
 * The worker delegates to the tenant-scoped `runHrisSync` usecase. The
 * dispatcher reads only connection ids via global prisma (SharePoint pattern).
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { enqueue } from './queue';
import { runHrisSync, type HrisSyncResult } from '@/app-layer/usecases/hris-sync';
import type { HrisSyncPayload } from './types';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import { fanOut, dispatchJobId, DAILY_BUCKET_MS } from './fan-out';
// One list, shared with usecases/hris-sync — see the note on its declaration.
import { HRIS_PROVIDERS } from '../integrations/providers/hris';

export async function runHrisSyncJob(payload: HrisSyncPayload): Promise<HrisSyncResult> {
    if (!payload.tenantId || !payload.connectionId) throw new Error('hris-sync requires tenantId + connectionId');
    // Whole result — a field-by-field shim drops errorMessage/noRetry silently.
    return runHrisSync({ tenantId: payload.tenantId, connectionId: payload.connectionId });
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
