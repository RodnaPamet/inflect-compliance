/**
 * #5080 — CLI over `recomputeClampedRiskScores`.
 *
 * The logic, and the reasoning behind it, live in
 * `src/lib/risk-matrix/recompute-clamped-scores.ts`, which takes the client as
 * a parameter so it is testable against a real database. This file is the
 * operator's door and nothing else.
 *
 * ## Usage
 *
 *   npx tsx scripts/recompute-risk-scores.ts            # dry run, counts only
 *   npx tsx scripts/recompute-risk-scores.ts --execute   # write
 *
 * Idempotent: a second run finds nothing, because it selects only rows whose
 * stored score disagrees with their own dimensions. Safe to re-run after a
 * partial failure. Exits non-zero if any row could not be corrected, so a
 * partial pass is never read as a completed one.
 */
import { prisma } from '@/lib/prisma';
import {
    recomputeClampedRiskScores,
    type RecomputeClient,
} from '@/lib/risk-matrix/recompute-clamped-scores';

async function main(): Promise<void> {
    const execute = process.argv.slice(2).includes('--execute');
    const out = await recomputeClampedRiskScores(
        prisma as unknown as RecomputeClient,
        { execute },
    );

    console.log(
        `[recompute-risk-scores] ${out.found} score(s) disagree with their own dimensions`,
    );
    for (const [tenantId, n] of [...out.byTenant].sort((a, b) => b[1] - a[1])) {
        console.log(`[recompute-risk-scores]   tenant ${tenantId}: ${n}`);
    }

    if (!execute) {
        console.log('[recompute-risk-scores] DRY RUN — nothing written. Re-run with --execute.');
        return;
    }

    console.log(`[recompute-risk-scores] applied=${out.applied} failed=${out.failed}`);
    if (out.failed > 0) {
        console.error(
            `[recompute-risk-scores] ${out.failed} row(s) could NOT be corrected — re-run; `
                + 'the pass is idempotent and will retry exactly those.',
        );
        process.exitCode = 1;
    }
}

main()
    .catch((err) => {
        console.error(
            '[recompute-risk-scores] FAILED:',
            err instanceof Error ? err.message : err,
        );
        process.exitCode = 1;
    })
    .finally(() => {
        void prisma.$disconnect();
    });
