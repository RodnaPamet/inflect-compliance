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
import { runIdentitySync } from '@/app-layer/usecases/identity-sync';
import type { IdentitySyncPayload } from './types';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';

const IDENTITY_PROVIDERS = ['okta', 'google-workspace', 'entra-id', 'active-directory'];

export async function runIdentitySyncJob(payload: IdentitySyncPayload): Promise<{
    executionId: string;
    status: string;
    upserted: number;
    deprovisioned: number;
}> {
    if (!payload.tenantId || !payload.connectionId) {
        throw new Error('identity-sync requires tenantId + connectionId');
    }
    const r = await runIdentitySync({ tenantId: payload.tenantId, connectionId: payload.connectionId });
    return { executionId: r.executionId, status: r.status, upserted: r.upserted, deprovisioned: r.deprovisioned };
}

/** Fan-out: one identity-sync per enabled Okta / Google Workspace connection. */
export async function runIdentitySyncDispatch(): Promise<{ connections: number; dispatched: number }> {
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

    let dispatched = 0;
    for (const conn of connections) {
        await enqueue('identity-sync', { tenantId: conn.tenantId, connectionId: conn.id });
        dispatched++;
    }
    logger.info('identity-sync-dispatch complete', { component: 'identity-sync', connections: connections.length, dispatched });
    return { connections: connections.length, dispatched };
}
