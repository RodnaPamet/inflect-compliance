/**
 * The standing of a legacy connection's latest snapshot, for the connection page.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS READ EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Match to people" posts `{ snapshotId }`, and no other read returns a snapshot
 * id: the pull and reconcile routes answer 202 with a job id, and their
 * `IntegrationExecution` rows record a status and a reason but neither the
 * snapshot nor its counts. Without this read the page would have nothing to send.
 *
 * It returns the same snapshot campaign creation builds from
 * (`LATEST_SNAPSHOT_ORDER`), and the same run over it (`LATEST_RESOLUTION_ORDER`),
 * so what the page reports as matched is what a campaign will find matched.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * COUNTS FROM ROWS, NEVER FROM A CLAIM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `rowCount` is the snapshot's own column, which the pull writes as a count of
 * the accounts that exist. The matching counts are a `groupBy` over the run's
 * resolution rows. Neither is a figure a job reported about itself.
 *
 * Statistics only: no account key, no login, no person. The refusal detail is
 * system-generated and never a cell value (`LegacyIngestError.detail`).
 *
 * @module app-layer/usecases/legacy-access-standing
 */

import { runInTenantContext } from '@/lib/db-context';
import { readPopulationCoverage, type PopulationCoverage } from '@/lib/legacy-access/coverage';
import { LATEST_RESOLUTION_ORDER, LATEST_SNAPSHOT_ORDER } from '@/lib/legacy-access/latest-snapshot';
import type { RequestContext } from '../types';
import { assertCanAdmin } from '../policies/common';

export interface LegacyReconciliationStanding {
    /** The run whose resolutions are this snapshot's current state. */
    readonly executionId: string;
    /** That run's `IntegrationExecution.status`, or null if the row is gone. */
    readonly status: string | null;
    readonly completedAt: string | null;
    /** Resolution rows written by the run, counted from the database. */
    readonly resolved: number;
    /** Resolution rows per outcome. An outcome with no rows is absent. */
    readonly byOutcome: Readonly<Record<string, number>>;
}

export interface LegacySnapshotStanding {
    readonly id: string;
    readonly status: 'PENDING' | 'COMPLETE' | 'PARTIAL';
    readonly pulledAt: string;
    readonly completedAt: string | null;
    /** Accounts stored. Zero on a refusal, which stores none. */
    readonly rowCount: number;
    /** Rows the far end sent before the pull finished or refused. */
    readonly rowsReceived: number;
    readonly refusalReason: string | null;
    readonly refusalDetail: string | null;
    readonly populationCoverage: PopulationCoverage;
    /** Null until a run over THIS snapshot has written resolutions. */
    readonly reconciliation: LegacyReconciliationStanding | null;
}

/**
 * Read a legacy connection's latest snapshot and the run over it.
 *
 * `assertCanAdmin`, as the pull and the reconcile requests are: the page reads
 * this to drive those two actions, and a snapshot's counts describe a customer's
 * legacy access table.
 */
export async function getLegacySnapshotStanding(
    ctx: RequestContext,
    connectionId: string
): Promise<{ readonly snapshot: LegacySnapshotStanding | null }> {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const snapshot = await db.legacyAccessSnapshot.findFirst({
            where: { tenantId: ctx.tenantId, connectionId },
            orderBy: LATEST_SNAPSHOT_ORDER,
            select: {
                id: true,
                status: true,
                pulledAt: true,
                completedAt: true,
                rowCount: true,
                rowsReceived: true,
                refusalReason: true,
                refusalDetail: true,
                populationCoverage: true,
            },
        });
        if (!snapshot) return { snapshot: null };

        const latest = await db.legacyAccountResolution.findFirst({
            where: { tenantId: ctx.tenantId, snapshotId: snapshot.id },
            orderBy: LATEST_RESOLUTION_ORDER,
            select: { executionId: true },
        });

        let reconciliation: LegacyReconciliationStanding | null = null;
        if (latest) {
            const groups = await db.legacyAccountResolution.groupBy({
                by: ['outcome'],
                where: { tenantId: ctx.tenantId, executionId: latest.executionId },
                _count: { _all: true },
            });
            const byOutcome: Record<string, number> = {};
            let resolved = 0;
            for (const g of groups) {
                byOutcome[g.outcome] = g._count._all;
                resolved += g._count._all;
            }
            const run = await db.integrationExecution.findFirst({
                where: { id: latest.executionId, tenantId: ctx.tenantId },
                select: { status: true, completedAt: true },
            });
            reconciliation = {
                executionId: latest.executionId,
                status: run?.status ?? null,
                completedAt: run?.completedAt?.toISOString() ?? null,
                resolved,
                byOutcome,
            };
        }

        return {
            snapshot: {
                id: snapshot.id,
                status: snapshot.status,
                pulledAt: snapshot.pulledAt.toISOString(),
                completedAt: snapshot.completedAt?.toISOString() ?? null,
                rowCount: snapshot.rowCount,
                rowsReceived: snapshot.rowsReceived,
                refusalReason: snapshot.refusalReason,
                refusalDetail: snapshot.refusalDetail,
                populationCoverage: readPopulationCoverage(snapshot.populationCoverage),
                reconciliation,
            },
        };
    });
}
