/**
 * The agentic runs THIS PROCESS is currently executing, and the SIGTERM drain
 * that leaves them resumable instead of stranded.
 *
 * ## The gap this closes
 *
 * A workflow run executes inline — `executeFrom` walks the step array in the
 * process that received the request. A rolling deploy sends SIGTERM to that
 * process mid-walk, and today the row is simply abandoned `RUNNING`.
 *
 * Nothing notices for a long time. `agent-run-reaper` selects on
 * `updatedAt < now - WALL_CLOCK_MS - REAP_GRACE_MS`, so the run sits RUNNING
 * with no executor for a full wall-clock budget plus ten minutes, and is then
 * settled to **FAILED** with a permanent hash-chained row saying it had no
 * executor. Which is true, and is also the deploy's fault rather than the
 * run's.
 *
 * Moving those runs to `PAUSED` on the way out turns a lost run into a
 * resumable one, and it needs no new resume machinery:
 * `resumeWorkflowRun` finds no PENDING step (a SIGTERM lands mid-step, not at a
 * checkpoint), falls through its `pending?.seq ?? run.stepCount - 1` branch,
 * and executes from `stepCount` — exactly the last completed seq plus one.
 * `stepCount` is written as `seq + 1` at each step's commit, so that is the
 * right number.
 *
 * ## Why a process-local registry and not a query
 *
 * The obvious implementation — "pause every RUNNING run" — is a cross-tenant
 * outage in a multi-instance deployment: instance A's SIGTERM would pause the
 * runs instance B is actively executing, and B would carry on writing to rows
 * marked PAUSED. There is no query that distinguishes "my run" from "another
 * pod's run", because the distinction is not in the database.
 *
 * So the set is held in memory, written by the one function that executes runs.
 * It is the only thing that knows.
 *
 * ## The contract this module owes the shutdown handler
 *
 * Bounded, idempotent, never throws — the same contract `shutdownTelemetry` and
 * `shutdownSentry` carry, because the handler races each stage against a budget
 * and a stage that throws would skip the ones after it.
 */
import { logger } from '@/lib/observability/logger';
import { runInGlobalContext } from '@/lib/db-context';

/**
 * Run ids this process is executing right now.
 *
 * Module scope, so it is per-process and shared by every request that process
 * handles — which is the whole point. Ids only: a cuid is globally unique, so
 * the drain needs no tenant to address the row, and holding tenant ids here
 * would be a second copy of something the row already knows.
 */
const inFlight = new Set<string>();

/** Begin executing `runId` in this process. */
export function trackInFlightRun(runId: string): void {
    inFlight.add(runId);
}

/**
 * Stop tracking `runId`. MUST be called from a `finally` — a run that threw is
 * no longer executing, and leaving it tracked would have the drain pause a row
 * that has already settled to FAILED.
 */
export function untrackInFlightRun(runId: string): void {
    inFlight.delete(runId);
}

/** A snapshot, for the drain and for tests. Never the live set. */
export function inFlightRunIds(): string[] {
    return [...inFlight];
}

/** Test-only: drop everything this process thinks it is running. @internal */
export function _resetInFlightRunsForTesting(): void {
    inFlight.clear();
}

export interface PauseInFlightRunsOutcome {
    /** How many runs this process believed it was executing. */
    readonly attempted: number;
    /** How many rows actually moved RUNNING -> PAUSED. */
    readonly paused: number;
    /** True when the budget expired before the write settled. */
    readonly timedOut: boolean;
}

/**
 * Mark this process's in-flight runs PAUSED so a later resume can pick them up.
 *
 * Never throws. Returns what it managed to do, so the caller can log a figure
 * rather than an assumption.
 *
 * No audit row is written, and that is deliberate rather than an oversight.
 * `appendAuditEntry` is hash-chained and therefore serialised, so N runs would
 * cost N dependent writes inside a budget measured in seconds — and stage 1 has
 * already flushed the audit stream, so anything written here would land in the
 * database but miss the SIEM. The run's own step ledger already records where it
 * stopped; this log line records why.
 */
export async function pauseInFlightRuns(budgetMs: number): Promise<PauseInFlightRunsOutcome> {
    const ids = inFlightRunIds();
    if (ids.length === 0) {
        return { attempted: 0, paused: 0, timedOut: false };
    }

    let timedOut = true;
    const work = (async (): Promise<number> => {
        // CONDITIONAL on status, exactly as the reaper is. Between the snapshot
        // above and this write a run may have completed, failed or been
        // aborted; `status: 'RUNNING'` means the update cannot walk a settled
        // run backwards into PAUSED.
        //
        // `id: { in: ids }` with a LITERAL array — the one `in` shape Prisma
        // validates. See the teardown note in tests/integration/db-helper.ts for
        // why `{ in: someUndefined }` would be an unpredicated write.
        const res = await runInGlobalContext((tx) =>
            tx.workflowRun.updateMany({
                where: { id: { in: ids }, status: 'RUNNING' },
                data: { status: 'PAUSED' },
            }),
        );
        return res.count;
    })();

    const paused = await Promise.race([
        work.then((count) => {
            timedOut = false;
            return count;
        }),
        new Promise<number>((resolve) => setTimeout(() => resolve(0), budgetMs)),
    ]).catch((err) => {
        timedOut = false;
        logger.warn('shutdown: pausing in-flight agentic runs failed', {
            component: 'shutdown',
            attempted: ids.length,
            error: err instanceof Error ? err.message : String(err),
        });
        return 0;
    });

    // Both numbers, always. "paused 3" alone cannot distinguish a clean drain
    // from one that found four runs and lost one — and the difference is a run
    // that will be reaped to FAILED in an hour.
    logger.info('shutdown: paused in-flight agentic runs', {
        component: 'shutdown',
        attempted: ids.length,
        paused,
        timedOut,
    });

    return { attempted: ids.length, paused, timedOut };
}

/**
 * Exported for the guard that asserts the drain is wired into the shutdown
 * handler. A drain nothing calls is the failure this whole module is about.
 */
export const PAUSE_IN_FLIGHT_RUNS_STAGE = 'pauseInFlightRuns';
