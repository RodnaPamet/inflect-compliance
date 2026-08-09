/**
 * Audit Readiness — Overview orchestrator.
 *
 * Single-call data contract for the readiness overview page. Replaces
 * the previous 1+N waterfall (`GET /audits/cycles` followed by N
 * parallel `GET /audits/cycles/:id/readiness` per cycle) with one
 * server-side aggregation.
 *
 * Why this exists:
 *
 *   • The overview page renders a card per audit cycle with the
 *     cycle's readiness score. The previous client-side flow:
 *       1. Fetch the cycle list.
 *       2. For each cycle, in parallel, fetch its readiness score.
 *     With N cycles, that's 1 + N HTTP round-trips. Each round-trip
 *     pays the WAN latency at least once. On a 100ms-RTT connection
 *     with 5 cycles, that's ~600ms blocked on network alone, even
 *     though the per-cycle DB queries themselves are fast.
 *
 *   • This orchestrator runs the same fan-out *server-side*, where
 *     the per-cycle work is bound by LAN-fast DB latency rather than
 *     WAN-fast HTTP latency. Total wall-clock time collapses to one
 *     RTT plus the slowest DB query.
 *
 * Failure-mode contract:
 *
 *   • If a single cycle's `scoreReadiness` throws, the orchestrator
 *     swallows the error for that cycle and emits no entry in
 *     `scoresByCycleId`. The page renders the cycle's card without
 *     a score (matching the previous client-side behaviour where
 *     each per-cycle fetch had its own try/catch). One bad cycle
 *     never takes the whole overview down.
 */
import { RequestContext } from '../../types';
import { listAuditCycles } from './cycles';
import { scoreReadiness, type ReadinessResult } from './scoring';

export interface ReadinessOverviewPayload {
    cycles: Awaited<ReturnType<typeof listAuditCycles>>;
    /**
     * Readiness scores keyed by cycle id. A cycle id is ABSENT from
     * this map when its score computation failed — the page should
     * render the cycle without a score rather than show a stale or
     * empty number.
     */
    scoresByCycleId: Record<string, ReadinessResult>;
}

/**
 * Max audit cycles scored concurrently.
 *
 * `scoreReadiness` internally opens ~10 SEQUENTIAL `runInTenantContext`
 * transactions per cycle (cycle lookup, weights, framework, requirement
 * mappings, controls, evidence, tasks, issues, findings count …). The
 * previous unbounded `Promise.allSettled(cycles.map(...))` fanned that
 * out over EVERY cycle at once, so a tenant with N cycles put up to N
 * transactions in flight simultaneously and opened ~10N per request —
 * enough to exhaust the Prisma / PgBouncer connection pool on a
 * cycle-heavy tenant (`Timed out fetching a new connection from the
 * connection pool`), which then fails cycles that would otherwise score
 * fine.
 *
 * A fixed-size worker pool caps in-flight work to this many cycles'
 * transactions at any instant while leaving each cycle's score
 * byte-identical (same ctx, same cycleId, same per-cycle failure
 * isolation). One-tx-per-cycle would be tighter still, but it would
 * require `scoreReadiness` to accept an injected `db` handle — a
 * cross-file signature change to the scoring module, out of scope here.
 */
const READINESS_SCORING_CONCURRENCY = 4;

export async function getReadinessOverview(
    ctx: RequestContext,
): Promise<ReadinessOverviewPayload> {
    const cycles = await listAuditCycles(ctx);

    // Fan out per-cycle readiness through a BOUNDED worker pool
    // (READINESS_SCORING_CONCURRENCY) rather than an unbounded
    // `Promise.allSettled` over every cycle — see the constant's doc for
    // the connection-pool-exhaustion footgun that motivated the cap.
    //
    // Tolerate per-cycle failures so a single broken framework doesn't
    // blank the page: a cycle whose `scoreReadiness` throws simply gets
    // no entry in `scoresByCycleId` (identical failure-mode contract to
    // the prior allSettled `.status === 'fulfilled'` filter).
    //
    // COMPUTE-ONLY (`scoreReadiness`) — the overview is a read surface
    // visited on every list navigation, so it must NOT persist a
    // snapshot per cycle (that write-amplification polluted the
    // readiness trend). Snapshots are recorded only on the deliberate
    // single-cycle scoring path.
    const scoresByCycleId: Record<string, ReadinessResult> = {};

    // Shared cursor into `cycles`; each worker atomically claims the next
    // index (`cursor++` has no intervening await, so it's race-free on the
    // single-threaded event loop) and scores that cycle, then loops. At
    // most `workerCount` cycles are ever in flight at once.
    let cursor = 0;
    const worker = async (): Promise<void> => {
        while (cursor < cycles.length) {
            const cycle = cycles[cursor++];
            try {
                scoresByCycleId[cycle.id] = await scoreReadiness(ctx, cycle.id);
            } catch {
                // Swallow — the cycle is intentionally absent from the map.
            }
        }
    };

    const workerCount = Math.min(READINESS_SCORING_CONCURRENCY, cycles.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { cycles, scoresByCycleId };
}
