/**
 * The leaver pass, as scheduled work.
 *
 *   - `identity-leaver-pass`     — one pass for one (tenant, provider).
 *   - `identity-leaver-dispatch` — daily fan-out over every tenant that has an
 *                                  enabled writable directory connection.
 *
 * ═══ ONE DISPATCH PER DECISION — WHY attempts IS 1 ═══
 *
 * Set deliberately in `JOB_DEFAULTS`, and it is a correctness constraint rather
 * than rate-limit courtesy. The journal's `INDETERMINATE` handling assumes one
 * dispatch per decision: a write whose result was never confirmed leaves a row
 * that a LATER pass reconciles by reading the account. BullMQ's queue default is
 * three exponential attempts, so an omitted entry would run the same pass three
 * times in ~35 seconds — each minting a fresh journal row per candidate, with
 * the second and third unable to tell their own predecessors' rows from a real
 * unconfirmed write. Retrying is not free here; it destroys the evidence the
 * retry would need.
 *
 * A failed pass is picked up by tomorrow's dispatch. Nothing is lost by waiting,
 * because the pass is idempotent by design and the HR feed is still there.
 *
 * ═══ THE UNIT IS (TENANT, PROVIDER) ═══
 *
 * The dispatcher reads connection ids and providers ONLY — no tenant content —
 * which is what makes the cross-tenant read acceptable, mirroring
 * `identity-sync-dispatch`. It then dedupes to distinct (tenantId, provider),
 * because two connections for one provider is a case the writer factory refuses
 * anyway and dispatching twice would just refuse twice.
 *
 * @module jobs/identity-leaver
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { enqueue } from './queue';
import type { IdentityLeaverPassPayload } from './types';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import { fanOut, dispatchJobId, DAILY_BUCKET_MS } from './fan-out';
import {
    runIdentityLeaverPass,
    type LeaverPassResult,
} from '@/app-layer/usecases/identity-leaver-pass';
import { WRITABLE_IDENTITY_PROVIDERS } from '@/app-layer/integrations/identity-writer-factory';

export async function runIdentityLeaverPassJob(
    payload: IdentityLeaverPassPayload,
): Promise<LeaverPassResult> {
    if (!payload.tenantId || !payload.provider) {
        throw new Error('identity-leaver-pass requires tenantId + provider');
    }
    return runIdentityLeaverPass({ tenantId: payload.tenantId, provider: payload.provider });
}

/** Fan-out: one leaver pass per (tenant, writable provider) with a live connection. */
export async function runIdentityLeaverDispatch(): Promise<{
    units: number;
    dispatched: number;
    failed: number;
}> {
    const connections = await drainPages((cursor) =>
        prisma.integrationConnection.findMany({
            where: { provider: { in: [...WRITABLE_IDENTITY_PROVIDERS] }, isEnabled: true },
            // Ids and provider only. No configJson, no secrets, no tenant
            // content — the read crosses tenants, so it carries nothing that
            // would matter if it were logged.
            select: { id: true, tenantId: true, provider: true },
            orderBy: { id: 'asc' },
            take: DRAIN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
    );

    // Distinct (tenant, provider). A tenant with two connections for one
    // provider is a case the writer factory refuses by name — dispatching twice
    // would produce the same refusal twice and nothing else.
    const units = new Map<string, { id: string; tenantId: string; provider: string }>();
    for (const c of connections) {
        const key = `${c.tenantId}:${c.provider}`;
        if (!units.has(key)) units.set(key, c);
    }
    const list = [...units.values()];

    const { dispatched, failed } = await fanOut(
        list,
        'identity-leaver-pass',
        (u) => ({ tenantId: u.tenantId, provider: u.provider }),
        (u) =>
            enqueue(
                'identity-leaver-pass',
                { tenantId: u.tenantId, provider: u.provider },
                {
                    // Deterministic per (tenant, provider, UTC day), so a
                    // dispatcher retry or a redeploy replaying the schedule
                    // cannot queue a second pass for the same day — which
                    // matters more here than for a sync, because a second pass
                    // would mint a second set of journal rows.
                    jobId: dispatchJobId(
                        'identity-leaver-pass',
                        `${u.tenantId}:${u.provider}`,
                        DAILY_BUCKET_MS,
                    ),
                },
            ),
    );

    logger.info('identity-leaver-dispatch complete', {
        component: 'identity-leaver',
        connections: connections.length,
        units: list.length,
        dispatched,
        failed,
    });

    if (failed > 0 && dispatched === 0) {
        throw new Error(`identity-leaver-dispatch: all ${failed} enqueues failed`);
    }
    return { units: list.length, dispatched, failed };
}
