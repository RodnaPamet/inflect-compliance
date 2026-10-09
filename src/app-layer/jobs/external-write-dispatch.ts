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

import {
    reconcileAcceptedExternalWrites,
    tenantsWithAcceptedExternalWrites,
    type ExternalWriteReconcileResult,
} from '@/app-layer/usecases/external-write-reconcile';

import type { ExternalWriteDispatchPayload } from './types';

export interface ExternalWriteDispatchJobResult extends ExternalWriteDispatchResult {
    /** Tenants this pass covered. */
    tenants: number;
    /**
     * The `ACCEPTED` reconcile half (#3334), reported SEPARATELY.
     *
     * Not folded into `applied`: that number means "writes this pass sent and
     * the far end took", and a promotion is a write an EARLIER pass sent whose
     * delivery has only now been confirmed. Adding them would make a pass that
     * sent nothing report work it did not do.
     */
    reconcile: ExternalWriteReconcileResult;
}

export async function runExternalWriteDispatchJob(
    payload: ExternalWriteDispatchPayload = {},
): Promise<ExternalWriteDispatchJobResult> {
    // One tenant when asked, otherwise only those actually holding a PENDING
    // row. A `groupBy` rather than a scan of every tenant: on almost every
    // deployment this list is empty, and the pass should cost nothing then.
    // The UNION of both populations. A tenant whose last write was accepted and
    // whose queue is now empty holds no PENDING row, so keying the pass on
    // PENDING alone would never revisit it — which is precisely the row the
    // reconcile half exists for.
    const tenants = payload.tenantId
        ? [payload.tenantId]
        : [
              ...new Set([
                  ...(await tenantsWithPendingExternalWrites(prisma)),
                  ...(await tenantsWithAcceptedExternalWrites(prisma)),
              ]),
          ];

    const total: ExternalWriteDispatchJobResult = {
        tenants: tenants.length,
        scanned: 0,
        applied: 0,
        refused: 0,
        indeterminate: 0,
        accepted: 0,
        reconcile: { scanned: 0, promoted: 0, notYet: 0, unreadable: 0, unverifiable: 0 },
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

        // A SEPARATE try, deliberately. The two halves answer different
        // questions — "send what was approved" and "did an earlier send
        // land" — and a tenant whose dispatch threw is exactly the tenant
        // whose accepted rows are most worth checking. Sharing one catch
        // would let the first failure silence the second half for that
        // tenant on every pass.
        try {
            const r = await reconcileAcceptedExternalWrites({ tenantId });
            total.reconcile.scanned += r.scanned;
            total.reconcile.promoted += r.promoted;
            total.reconcile.notYet += r.notYet;
            total.reconcile.unreadable += r.unreadable;
            total.reconcile.unverifiable += r.unverifiable;
        } catch (err) {
            // Nothing is settled on this path, so a failure is a delay and the
            // next pass retries. The row stays ACCEPTED either way.
            logger.error('external write reconcile failed for one tenant', {
                component: 'external-write-reconcile',
                tenantId,
                error: (err as Error).message,
            });
        }
    }
    return total;
}
