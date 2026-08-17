/**
 * One sync at a time per connection.
 *
 * ## The reachable corruption
 *
 * `POST /api/t/:slug/integrations/sharepoint/sync` enqueues a delta sync with
 * no job id, on the default 60/min mutation tier. Double-clicking "Sync now" is
 * enough to get two running at once, and the delta importer is not safe under
 * concurrency:
 *
 *   - `readDeltaTokens` / `writeDeltaTokens` are a read-modify-write of
 *     `configJson` in SEPARATE transactions, so two runs both start from the
 *     same token and both replay the same change set;
 *   - `importOne` always calls `uploadEvidenceFile`, creating a NEW Evidence
 *     row. Only the *mapping* is upserted.
 *
 * So the same SharePoint file becomes two Evidence rows and one mapping — one
 * of them orphaned, with no provenance link back to the drive it came from. In
 * a compliance product that is a document an auditor sees twice, and the copy
 * they cannot trace is the one that raises questions.
 *
 * `identity-sync` has a quieter version of the same problem: two overlapping
 * runs compute their `seen` sets independently, and the deprovision reconcile
 * (`updateMany` … `externalUserId: { notIn: seen }`) from the run that started
 * EARLIER can flip accounts the later run just upserted to DEPROVISIONED. That
 * is the wrongful-mass-deprovision hazard the truncation guard already worries
 * about, arriving through a different door.
 *
 * ## The reaper is the acquire predicate
 *
 * A worker that dies holding the lock must not wedge the connection forever, so
 * the lock is a LEASE: acquire succeeds if the row is unlocked *or* the existing
 * lock is older than `SYNC_LOCK_TTL_MS`.
 *
 * That is deliberately not a separate sweeper job. A sweeper has a window
 * between "lock went stale" and "sweeper ran" during which the connection is
 * still wedged, and it is one more scheduled thing that can itself fail
 * silently. Folding the reap into the acquire removes both problems: the lock
 * is reaped exactly when someone wants it, by the process that wants it.
 *
 * ## The TTL is a real tradeoff
 *
 * A lease can be stolen from a holder that is merely SLOW rather than dead, and
 * then two runs proceed anyway — that is inherent to lease-based locking, not a
 * bug in this implementation. The token check on release limits the damage (a
 * slow holder cannot clear a lock it no longer owns), but it cannot prevent the
 * overlap.
 *
 * So the TTL is set well above any plausible run and well below the schedule
 * interval: long enough that stealing means the holder really is gone, short
 * enough that a wedged connection self-heals before its next scheduled run
 * (4 h for SharePoint, 24 h for the daily syncs).
 *
 * @see tests/unit/integrations-connection-lock.test.ts
 */
import { randomUUID } from 'node:crypto';
import type { PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';

/**
 * How long a held lock stays valid before another run may steal it.
 *
 * 30 minutes: comfortably longer than any observed sync (the longest is a
 * 5000-account directory enumeration at a 120 s per-page budget), and far
 * shorter than the tightest schedule interval (4 h), so a lock left behind by a
 * killed worker is gone before the next scheduled run.
 */
export const SYNC_LOCK_TTL_MS = 30 * 60_000;

/**
 * Take the per-connection sync lock.
 *
 * The whole thing is one conditional `updateMany`, so the check and the claim
 * are a single atomic statement — a read-then-write would leave exactly the race
 * this exists to close.
 *
 * @returns the lock token, or `null` if another run holds a fresh lock.
 */
export async function acquireSyncLock(
    db: PrismaTx,
    connectionId: string,
    now: Date = new Date(),
    ttlMs: number = SYNC_LOCK_TTL_MS,
): Promise<string | null> {
    const token = randomUUID();
    const staleBefore = new Date(now.getTime() - ttlMs);

    const r = await db.integrationConnection.updateMany({
        where: {
            id: connectionId,
            OR: [
                { syncLockedAt: null },
                // The reaper: a lease older than the TTL is fair game.
                { syncLockedAt: { lt: staleBefore } },
            ],
        },
        data: { syncLockedAt: now, syncLockToken: token },
    });

    if (r.count === 0) {
        logger.info('sync already running for connection — skipping', {
            component: 'integrations',
            connectionId,
        });
        return null;
    }
    return token;
}

/**
 * Release the lock, but only if we still hold it.
 *
 * The token comparison matters: if this run was slow enough for its lease to be
 * reaped and another run to start, clearing the lock unconditionally would
 * unlock the connection *while that other run is still going* — turning one
 * overlap into an unbounded number.
 *
 * @returns true if this call actually released the lock it held.
 */
export async function releaseSyncLock(
    db: PrismaTx,
    connectionId: string,
    token: string,
): Promise<boolean> {
    const r = await db.integrationConnection.updateMany({
        where: { id: connectionId, syncLockToken: token },
        data: { syncLockedAt: null, syncLockToken: null },
    });

    if (r.count === 0) {
        // Not an error — it means our lease was reaped mid-run. Worth seeing,
        // because it means a sync ran longer than SYNC_LOCK_TTL_MS.
        logger.warn('sync lock was already reaped — this run overran its lease', {
            component: 'integrations',
            connectionId,
            ttlMs: SYNC_LOCK_TTL_MS,
        });
        return false;
    }
    return true;
}
