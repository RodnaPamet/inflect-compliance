/**
 * SEND THE EXTERNAL WRITES A HUMAN APPROVED (#2861).
 *
 * `approveAgentProposal` opens an `ExternalWriteJournal` row `PENDING` and sends
 * nothing; this pass sends it. The refusals it can reach — the rung narrowed,
 * the pairing removed, the record drifted — all settle the row `FAILED` with the
 * reason on it, and none of them send anything.
 *
 * ## A dead worker here is a DELAY, never an unreviewed write
 *
 * Worth stating because the identity equivalent's failure mode is the opposite
 * way round. Nothing this job does grants authority: the human already approved,
 * the rung was already checked at approval, and the journal row already exists.
 * If this never runs, approved writes sit `PENDING` and the journal's own
 * unsettled sweep is what surfaces them. What a missed run cannot do is send
 * something nobody approved.
 */
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import {
    runExternalWriteDispatch,
    tenantsWithPendingExternalWrites,
    type ExternalWriteDispatchResult,
} from '@/app-layer/usecases/external-write-dispatch';

import type { ExternalWriteDispatchPayload } from './types';

export interface ExternalWriteDispatchJobResult extends ExternalWriteDispatchResult {
    /** Tenants this pass covered. */
    tenants: number;
}

export async function runExternalWriteDispatchJob(
    payload: ExternalWriteDispatchPayload = {},
): Promise<ExternalWriteDispatchJobResult> {
    // One tenant when asked, otherwise only those actually holding a PENDING
    // row. A `groupBy` rather than a scan of every tenant: on almost every
    // deployment this list is empty, and the pass should cost nothing then.
    const tenants = payload.tenantId
        ? [payload.tenantId]
        : await tenantsWithPendingExternalWrites(prisma);

    const total: ExternalWriteDispatchJobResult = {
        tenants: tenants.length,
        scanned: 0,
        applied: 0,
        refused: 0,
        indeterminate: 0,
        accepted: 0,
    };

    for (const tenantId of tenants) {
        try {
            const r = await runExternalWriteDispatch({ tenantId });
            total.scanned += r.scanned;
            total.applied += r.applied;
            total.refused += r.refused;
            total.indeterminate += r.indeterminate;
            // Accumulated too, or an accepted write is counted NOWHERE: a pass
            // that accepted twelve requests would report zero applied, zero
            // refused and zero indeterminate, and read as a pass that did
            // nothing.
            total.accepted += r.accepted;
        } catch (err) {
            // One tenant's broken connection must not stop every other tenant's
            // approved writes. The row stays PENDING and the next pass retries
            // it, which is safe precisely because nothing was sent.
            logger.error('external write dispatch failed for one tenant', {
                component: 'external-write-dispatch',
                tenantId,
                error: (err as Error).message,
            });
        }
    }
    return total;
}
