/**
 * THE RUN LEASE: one run executes in at most one place at a time (#5854
 * finding 2).
 *
 * ## The defect
 *
 * `agent-run-execute` is retried (`attempts: 3`) and BullMQ redelivers a job
 * whose worker stopped renewing its lock (a stall: an event loop blocked past
 * `lockDuration`, a process that died). Nothing on the `WorkflowRun` row said a
 * worker was already executing it, and `executeQueuedWorkflowRun` checked only
 * `status === 'RUNNING'`, which an executing run also is. So a redelivery, or a
 * retry while the first attempt still ran, executed ONE run twice at the same
 * time: two model loops, two Managed Agents sessions, tools run twice, two
 * writers on one ledger.
 *
 * ## The lease
 *
 * Before it executes, a worker CLAIMS the run: one conditional UPDATE that
 * sets `leaseHolder` to a fresh attempt token and `leaseExpiresAt` to the
 * database's `now()` plus the TTL, only where the run is RUNNING and nobody
 * holds it or the holder's lease has lapsed. Exactly one claimant can win that
 * statement. The holder renews while it runs and releases when it stops.
 *
 * A worker that cannot claim does nothing, and that is not an error. Before it
 * gives up it watches the lease for one TTL: a holder that is alive renews it
 * and the watcher leaves, and a holder that died lets it lapse and the watcher
 * takes the run over. That is what keeps a crashed worker's run recoverable by
 * BullMQ's own redelivery, which can arrive before the dead holder's lease has
 * run out.
 *
 * ## The token is a fence, not only a lock
 *
 * A lease that lapsed is not proof its holder stopped: a process can be paused
 * past the TTL and wake. So the holder's token rides on its `RequestContext`
 * (`runLeaseToken`), and every write the engine makes is conditional on the
 * row still naming it:
 *
 *   - `updateRun` (every settlement and every accounting write) matches only
 *     the row this token holds;
 *   - `recordStep` (the one place a step is written) checks the token under a
 *     row lock in the step's own transaction, so a claim cannot slip between
 *     the check and the insert;
 *   - `isRunAborted`, the check every reasoning engine already makes where it
 *     reads the kill switch, reads a run held by somebody else as stopped, so
 *     the engine stops there exactly as it does at an operator's Abort.
 *
 * EXPIRY DOES NOT FENCE. The holder is fenced only once the row names somebody
 * else (or nobody: the SIGTERM drain and the reaper clear it). A holder whose
 * renewals missed a beat but whom nobody replaced simply renews again; a
 * short TTL therefore costs nothing unless another worker is actually waiting.
 *
 * ## The database's clock
 *
 * Every comparison and every expiry is the database's `now()`, never an
 * application host's, so two workers on two hosts with skewed clocks still
 * agree on whether a lease has lapsed. The statements are raw SQL for that
 * reason, and so that a renewal every few seconds writes no audit row and does
 * not move `updatedAt`, which the reaper reads as "when did this run last make
 * progress".
 */
import { randomUUID } from 'node:crypto';

import type { RequestContext } from '@/app-layer/types';
import { withTenantDb, type PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import { ENGINE_CAPS } from '@/lib/agentic/workflow-types';

/** How long a claim lasts unless renewed, and how often the holder renews it. */
export interface RunLeaseTiming {
    readonly ttlMs: number;
    readonly renewMs: number;
}

/**
 * Sixty seconds, renewed every fifteen: four renewals must fail in a row
 * before anybody may take the run over, and a waiting worker learns that the
 * holder is alive within one renewal. A lapse only matters when another worker
 * is waiting, because expiry alone fences nobody.
 */
export const RUN_LEASE_TIMING: RunLeaseTiming = { ttlMs: 60_000, renewMs: 15_000 };

/**
 * How long a holder keeps renewing at most: the engine's wall clock plus the
 * reaper's grace. A segment cannot legitimately run longer than that from its
 * claim (its clock base is at or before the claim, and every engine halts at
 * `WALL_CLOCK_MS` from it), so a holder still renewing past it is wedged in a
 * call that will not return. It stops renewing, the lease lapses, and the
 * reaper settles the run as it settled every wedged run before the lease, with
 * the wedged worker fenced if it ever wakes.
 */
export const RUN_LEASE_MAX_HOLD_MS = ENGINE_CAPS.WALL_CLOCK_MS + 10 * 60 * 1000;

/** Why a worker did not get the run. */
export type RunLeaseRefusal =
    /** The run is not RUNNING (settled, paused, parked, aborted) or not there. */
    | 'NOT_RUNNING'
    /** Another worker holds it and renewed it while this one watched. */
    | 'LEASE_HELD';

export type RunLeaseClaim = { readonly token: string } | { readonly refused: RunLeaseRefusal };

interface LeaseState {
    readonly status: string | null;
    readonly holder: string | null;
    readonly expiresAt: Date | null;
    readonly dbNow: Date;
}

/** A fresh attempt token. Random, so no two attempts, on any host, share one. */
export function newRunLeaseToken(): string {
    return randomUUID();
}

/** The one conditional UPDATE that takes the run. True when this token won. */
async function tryClaim(tenantId: string, runId: string, token: string, ttlMs: number): Promise<boolean> {
    const taken = await withTenantDb(tenantId, (db) =>
        db.$executeRaw`
            UPDATE "WorkflowRun"
               SET "leaseHolder" = ${token},
                   "leaseExpiresAt" = now() + (${ttlMs}::int * interval '1 millisecond')
             WHERE "id" = ${runId}
               AND "tenantId" = ${tenantId}
               AND "status" = 'RUNNING'
               AND ("leaseHolder" IS NULL OR "leaseExpiresAt" <= now())`,
    );
    return taken === 1;
}

async function readLease(tenantId: string, runId: string): Promise<LeaseState> {
    const rows = await withTenantDb(tenantId, (db) =>
        db.$queryRaw<Array<{ status: string; leaseHolder: string | null; leaseExpiresAt: Date | null; dbNow: Date }>>`
            SELECT "status"::text AS "status", "leaseHolder", "leaseExpiresAt", now() AS "dbNow"
              FROM "WorkflowRun"
             WHERE "id" = ${runId} AND "tenantId" = ${tenantId}`,
    );
    const row = rows[0];
    if (!row) return { status: null, holder: null, expiresAt: null, dbNow: new Date() };
    return { status: row.status, holder: row.leaseHolder, expiresAt: row.leaseExpiresAt, dbNow: row.dbNow };
}

/**
 * CLAIM THE RUN, or say why not.
 *
 * Takes it at once when nobody holds it. When somebody does, watches the lease
 * for at most one TTL (polling at the renewal interval): a holder that renews
 * is alive, and the watcher leaves with `LEASE_HELD`; a lease that lapses
 * unrenewed belonged to a worker that died, and the watcher takes the run
 * over. A run that stops being RUNNING while it watches (settled, paused,
 * aborted) is `NOT_RUNNING`.
 *
 * `sleep` is injectable so a test need not wait on a real timer.
 */
export async function claimRunLease(
    tenantId: string,
    runId: string,
    opts: { timing?: RunLeaseTiming; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RunLeaseClaim> {
    const timing = opts.timing ?? RUN_LEASE_TIMING;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const token = newRunLeaseToken();

    if (await tryClaim(tenantId, runId, token, timing.ttlMs)) return { token };
    const first = await readLease(tenantId, runId);
    if (first.status !== 'RUNNING') return { refused: 'NOT_RUNNING' };

    // Watch at most until the lease the holder holds NOW would lapse, and never
    // longer than one TTL plus one renewal: past that, a holder that has not
    // renewed is not coming back, and one that has is alive.
    const untilLapse = first.expiresAt ? Math.max(0, first.expiresAt.getTime() - first.dbNow.getTime()) : 0;
    const deadline = Date.now() + Math.min(untilLapse, timing.ttlMs) + timing.renewMs;
    while (Date.now() < deadline) {
        await sleep(Math.max(1, Math.min(timing.renewMs, deadline - Date.now())));
        if (await tryClaim(tenantId, runId, token, timing.ttlMs)) return { token };
        const now = await readLease(tenantId, runId);
        if (now.status !== 'RUNNING') return { refused: 'NOT_RUNNING' };
        // RENEWED, or taken by a third worker: either way somebody alive holds it.
        const renewed =
            now.holder !== first.holder ||
            (now.expiresAt?.getTime() ?? 0) > (first.expiresAt?.getTime() ?? 0);
        if (renewed) return { refused: 'LEASE_HELD' };
    }
    return { refused: 'LEASE_HELD' };
}

/**
 * Push the holder's expiry forward. Matches only while the row still names
 * this token, expired or not: a holder nobody replaced keeps the run. False
 * when the token no longer holds it.
 */
export async function renewRunLease(
    tenantId: string,
    runId: string,
    token: string,
    ttlMs: number = RUN_LEASE_TIMING.ttlMs,
): Promise<boolean> {
    const renewed = await withTenantDb(tenantId, (db) =>
        db.$executeRaw`
            UPDATE "WorkflowRun"
               SET "leaseExpiresAt" = now() + (${ttlMs}::int * interval '1 millisecond')
             WHERE "id" = ${runId} AND "tenantId" = ${tenantId} AND "leaseHolder" = ${token}`,
    );
    return renewed === 1;
}

/**
 * Let the run go. Matches only the row this token holds, so a worker that lost
 * the run never releases the lease its successor holds.
 */
export async function releaseRunLease(tenantId: string, runId: string, token: string): Promise<void> {
    await withTenantDb(tenantId, (db) =>
        db.$executeRaw`
            UPDATE "WorkflowRun"
               SET "leaseHolder" = NULL, "leaseExpiresAt" = NULL
             WHERE "id" = ${runId} AND "tenantId" = ${tenantId} AND "leaseHolder" = ${token}`,
    );
}

/**
 * Renew the lease every `renewMs` until `stop()` is called, the token stops
 * holding the run, or `RUN_LEASE_MAX_HOLD_MS` has passed since the claim. A
 * renewal that throws is logged and retried at the next tick: expiry alone
 * fences nobody, so a missed renewal costs nothing unless a worker is waiting.
 *
 * The timer is unref'd and owned by the caller, which stops it in a `finally`.
 */
export function keepRunLease(
    tenantId: string,
    runId: string,
    token: string,
    timing: RunLeaseTiming = RUN_LEASE_TIMING,
): { stop(): void } {
    const claimedAt = Date.now();
    let inFlight = false;
    const timer = setInterval(() => {
        if (Date.now() - claimedAt > RUN_LEASE_MAX_HOLD_MS) {
            clearInterval(timer);
            logger.warn('run lease: holding past the wall clock and the reaper grace; renewal stopped', {
                component: 'agentic',
                tenantId,
                runId,
            });
            return;
        }
        if (inFlight) return;
        inFlight = true;
        renewRunLease(tenantId, runId, token, timing.ttlMs)
            .then((held) => {
                if (!held) clearInterval(timer);
            })
            .catch((err: unknown) => {
                logger.warn('run lease: renewal failed; retrying at the next tick', {
                    component: 'agentic',
                    tenantId,
                    runId,
                    error: err instanceof Error ? err.message : 'a non-Error value was thrown',
                });
            })
            .finally(() => {
                inFlight = false;
            });
    }, timing.renewMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
}

/**
 * Has this execution lost the run? True only for a context that holds a lease
 * (`runLeaseToken`) whose row now names somebody else, or nobody. A context
 * with no token never loses anything: every inline run reads false.
 */
export function runLeaseLost(ctx: RequestContext, row: { leaseHolder: string | null } | null | undefined): boolean {
    if (ctx.runLeaseToken === undefined) return false;
    return (row?.leaseHolder ?? null) !== ctx.runLeaseToken;
}

/**
 * HAS ANOTHER WORKER TAKEN THIS RUN OVER? (#5854, owner decision 2026-11-25)
 *
 * True only for a context that holds a lease (`runLeaseToken`) whose row now
 * names a DIFFERENT, non-null holder: a successor claimed the run after this
 * execution's lease lapsed. False when the row still names this token, and
 * false when it names nobody (the SIGTERM drain or the reaper cleared it):
 * those stop the run, they do not hand it on. A context with no token never
 * hands anything over, and costs no query.
 *
 * The Managed Agents engine asks it before it touches its session once its
 * run reads stopped: a successor RECONNECTS to that session and continues in
 * it, so the worker it took the run from must not answer the session's open
 * calls, interrupt it or delete it.
 */
export async function runLeaseTakenOver(ctx: RequestContext, runId: string): Promise<boolean> {
    if (ctx.runLeaseToken === undefined) return false;
    const now = await readLease(ctx.tenantId, runId);
    return now.holder !== null && now.holder !== ctx.runLeaseToken;
}

/**
 * THE FENCE INSIDE A WRITE's TRANSACTION. True when the context holds no lease
 * (nothing to fence) or when the row still names its token; the row is then
 * locked `FOR SHARE` until the transaction ends, so a claim by another worker
 * waits for this write to commit and reads the ledger with it in.
 */
export async function holdsRunLeaseInTx(db: PrismaTx, ctx: RequestContext, runId: string): Promise<boolean> {
    if (ctx.runLeaseToken === undefined) return true;
    const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "WorkflowRun"
         WHERE "id" = ${runId} AND "tenantId" = ${ctx.tenantId} AND "leaseHolder" = ${ctx.runLeaseToken}
         FOR SHARE`;
    return rows.length === 1;
}

/**
 * Thrown out of `executeFrom` when the execution lost its lease, so the worker
 * reports a refusal rather than a settlement it did not make.
 */
export class RunLeaseLostError extends Error {
    constructor(runId: string) {
        super(`run_lease_lost: another worker holds run ${runId}, so this attempt stopped and wrote nothing more.`);
        this.name = 'RunLeaseLostError';
    }
}
