/**
 * cloud-posture-collect-dispatch — the fan-out that was missing.
 *
 * `aws-posture-collect`, `azure-posture-collect` and `gcp-posture-collect`
 * were registered as executors and never enqueued by anything. Not merely
 * unscheduled: `grep` across `src/` finds no call site at all, so the
 * framework-rollup collectors behind them — the path that maps one benchmark
 * run across every covered control and writes rolling Evidence — were dead
 * code.
 *
 * The product consequence is the one that matters for a compliance tool: an
 * admin connects AWS, clicks Test, sees a green tick, and reasonably concludes
 * that benchmark evidence now accrues. It did not. Evidence appeared only when
 * someone clicked Sync by hand.
 *
 * (Posture *checking* did still run, via `automation-runner` resolving a
 * control's `automationKey` per control. What never ran is this rolling
 * collector.)
 *
 * ## Cadence
 *
 * Daily at 01:20 UTC. Three constraints picked that, and none of them is
 * "an empty-looking hour":
 *
 *   - BEFORE the consumers. `daily-evidence-expiry` runs at 06:00 and
 *     `notification-dispatch` at 07:00. Collect after those and every batch
 *     waits ~21h before anything reads it.
 *   - OUTSIDE 02:00-06:00, already carrying sharepoint-subscription-renew,
 *     risk-snapshot, vendor-monitoring, identity-sync, hris-sync and
 *     retention-sweep.
 *   - OFF the hour boundary. `:20` dodges the hourly job and the `0 * / 4`
 *     SharePoint fan-out, and misses the `* / 15` automation tick. Only the
 *     `* / 5` trio overlaps, which nothing can avoid.
 *
 * Daily rather than the 15-minute automation tick because a run is expensive:
 * an external Powerpipe child process per connection, 15-minute timeout,
 * 64 MB output buffer. The evidence it writes carries a 30-day
 * `nextReviewDate`, so daily is already ~30x more often than the review cycle
 * needs.
 *
 * ## Why this one paginates when its siblings do not
 *
 * `identity-sync-dispatch` — the shape this otherwise copies — uses a bare
 * `take: 1000` and then logs `connections: connections.length`. At the cap
 * those two facts are indistinguishable: an operator reading
 * `connections: 1000` cannot tell a true total from a truncated one, and
 * tenants past the boundary never sync, indefinitely, under a green job run.
 *
 * A new fan-out should not be born with that defect, so this one drains the
 * full set by cursor. The sibling dispatchers are fixed separately; the shared
 * `recordSyncTruncated` metric already exists for exactly this signature.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { enqueue } from './queue';
import { fanOut, dispatchJobId, DAILY_BUCKET_MS } from './fan-out';
import type { JobName } from './types';

/** Provider id → the collect job that services it. */
const POSTURE_JOB_BY_PROVIDER: Record<string, JobName> = {
    'aws-posture': 'aws-posture-collect',
    'azure-posture': 'azure-posture-collect',
    'gcp-posture': 'gcp-posture-collect',
};

/**
 * Page size for the cursor drain. Not a cap — the loop continues until the
 * connection set is exhausted; this only bounds how many ids are in memory at
 * once.
 */
const PAGE_SIZE = 500;

/** Fan out one collect job per enabled cloud-posture connection. */
export async function runCloudPostureCollectDispatch(): Promise<{
    connections: number;
    dispatched: number;
    failed: number;
    byProvider: Record<string, number>;
}> {
    const providers = Object.keys(POSTURE_JOB_BY_PROVIDER);
    const byProvider: Record<string, number> = {};
    let connections = 0;
    let dispatched = 0;
    let failed = 0;
    let cursor: string | undefined;

    // Drains every page. The D1 scan flags a `findMany` inside a loop, but
    // this is cursor PAGINATION over one logical result set, not a per-row
    // read — the shape D1 exists to prevent (one query per connection) is
    // exactly what this avoids. The marker has to sit on the loop's opening
    // line; the guard reads that line or the matched read line, not a comment
    // block above them.
    for (;;) { // guardrail-allow: n+1 — cursor pagination, not a per-row read
        const page = await prisma.integrationConnection.findMany({
            where: { provider: { in: providers }, isEnabled: true },
            select: { id: true, tenantId: true, provider: true },
            orderBy: { id: 'asc' },
            take: PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (page.length === 0) break;

        // Defensive: `where` already restricts to the three providers, so a
        // miss means the map and the filter have drifted apart.
        const routable = page.filter((c) => {
            connections++;
            return Boolean(POSTURE_JOB_BY_PROVIDER[c.provider]);
        });

        // Deterministic id per (connection, UTC day) + isolated failures. Both
        // were missing here; see ./fan-out for why they compound.
        const r = await fanOut(
            routable,
            'cloud-posture',
            (conn) => ({ tenantId: conn.tenantId, connectionId: conn.id, provider: conn.provider }),
            async (conn) => {
                const job = POSTURE_JOB_BY_PROVIDER[conn.provider];
                await enqueue(
                    job,
                    { tenantId: conn.tenantId, connectionId: conn.id },
                    { jobId: dispatchJobId(job, conn.id, DAILY_BUCKET_MS) },
                );
                byProvider[conn.provider] = (byProvider[conn.provider] ?? 0) + 1;
            },
        );
        dispatched += r.dispatched;
        failed += r.failed;

        if (page.length < PAGE_SIZE) break;
        cursor = page[page.length - 1].id;
    }

    logger.info('cloud-posture-collect-dispatch complete', {
        component: 'cloud-posture',
        connections,
        dispatched,
        failed,
        byProvider,
    });

    // Nothing got out at all — success here would report a clean run that
    // dispatched no posture collection for any tenant.
    if (failed > 0 && dispatched === 0) {
        throw new Error(`cloud-posture-collect-dispatch: all ${failed} enqueues failed`);
    }
    return { connections, dispatched, failed, byProvider };
}
