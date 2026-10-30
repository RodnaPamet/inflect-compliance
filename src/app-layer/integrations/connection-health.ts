/**
 * Credential health on a connection — and, more importantly, clearing it.
 *
 * ## What was invisible
 *
 * When a background sync hit a revoked credential, the failure was recorded on
 * `IntegrationExecution` and nowhere else. `IntegrationConnection` carries
 * `lastTestedAt` / `lastTestStatus`, but those belong to the operator-initiated
 * "Test connection" button — a background sync never touched them. So a
 * connection whose token was revoked months ago still presented as healthy, and
 * the only way to find out was to open the execution history of a job nobody
 * watches.
 *
 * ## Why clearing is the load-bearing half
 *
 * Setting the flag is easy and nearly useless on its own. A "credential
 * revoked" banner that survives the admin fixing the credential is worse than
 * no banner: it trains people to ignore the one signal that means someone must
 * act. So `clearAuthFailure` runs on EVERY successful sync, not only on the
 * sync immediately after a failure, and it is deliberately cheap enough
 * (`updateMany` with a `not: null` predicate — no row read, no write when
 * already clear) that there is never a reason to make it conditional.
 *
 * ## Why only auth failures
 *
 * `IntegrationAuthError` is narrow by construction: 401/403 only, never 404 and
 * never 429 (see `http-resilience.ts`). A missing group or a throttle is a
 * failed *request*, not a bad *credential*. Widening this to every terminal
 * error would put the banner up for a deleted drive, which is the same false
 * alarm in a different costume.
 *
 * @see tests/unit/integrations-connection-health.test.ts
 */
import type { PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import { IntegrationAuthError } from './http-resilience';
import { recordConnectionAuthState } from '@/lib/observability/integration-metrics';

/** Longest reason we persist — the column is free text and this is UI copy. */
const MAX_REASON_LEN = 500;

/**
 * Record that this connection's CREDENTIAL is bad.
 *
 * No-op for any error that is not an `IntegrationAuthError`, so call sites can
 * pass whatever they caught without pre-classifying.
 *
 * @returns true when the connection was marked.
 */
export async function markAuthFailure(
    db: PrismaTx,
    connectionId: string,
    err: unknown,
    now: Date = new Date(),
    provider = 'unknown',
): Promise<boolean> {
    if (!(err instanceof IntegrationAuthError)) return false;

    const reason = err.message.slice(0, MAX_REASON_LEN);
    await db.integrationConnection.updateMany({
        where: { id: connectionId },
        data: { authFailedAt: now, authFailureReason: reason },
    });

    logger.warn('integration credential rejected — connection marked', {
        component: 'integrations',
        connectionId,
        status: err.status,
    });
    recordConnectionAuthState({ provider, state: 'marked' });
    return true;
}

/**
 * Clear the credential-failure state after a successful sync.
 *
 * `updateMany` with a `not: null` predicate so the common case (already clear)
 * costs one indexed no-op UPDATE and never writes a row — cheap enough that
 * every success path can call it unconditionally, which is what keeps the
 * banner from going stale.
 *
 * @returns true when a stale failure was actually cleared.
 */
export async function clearAuthFailure(
    db: PrismaTx,
    connectionId: string,
    provider = 'unknown',
): Promise<boolean> {
    const r = await db.integrationConnection.updateMany({
        where: { id: connectionId, authFailedAt: { not: null } },
        data: { authFailedAt: null, authFailureReason: null },
    });

    if (r.count > 0) {
        logger.info('integration credential recovered — connection cleared', {
            component: 'integrations',
            connectionId,
        });
        // Only counted when something was ACTUALLY cleared. Counting every
        // success-path call would drown the signal in the common case and make
        // "an operator fixed a credential" indistinguishable from "a sync ran".
        recordConnectionAuthState({ provider, state: 'recovered' });
    }
    return r.count > 0;
}

/**
 * Record that this connection's sync cannot RUN — distinct from running and
 * being refused (#4389).
 *
 * The scheduled SharePoint delta sync borrows an active Owner or Admin who may
 * upload evidence, so the evidence it writes names a real member. Since #4375 a
 * workspace with no such member means the connection is never queued at all. It
 * reported that in the dispatch result and a `warn` line, and nowhere an admin
 * looks.
 *
 * ## Why not an IntegrationExecution row
 *
 * It would have made the page read BETTER while the connection got worse.
 * `getConnectionsHealth` took `lastActivity` from the most recent execution of
 * ANY status when this was written, so a row written every four hours for a
 * connection that never syncs would have cleared its stale flag. The signal
 * would have cancelled itself. Freshness now counts successes only (#4581 D),
 * which closes that particular route, but a row recording a sync that did not
 * happen would still be a false execution in the connection's history.
 *
 * ## Why its own pair of columns
 *
 * Same argument that keeps `authFailure*` apart from `lastTested*`: a revoked
 * credential and a permissions configuration are different facts with different
 * fixes. One field would let a credential recovery clear a permissions block, or
 * the reverse, and a tenant that cannot tell them apart cannot act on either.
 *
 * `reason` is a stable machine token (`DELTA_SYNC_UNROUTABLE` / `BORROW_FAILURE`
 * values), not a sentence: the UI owns the words, so the copy can change without
 * a migration and without re-reading rows written by an older build.
 *
 * Takes an ARRAY because its caller is a cross-tenant dispatcher: one statement
 * per reason beats one per connection, and a single predicate cannot drift from
 * a looped one.
 *
 * @returns how many connections this actually changed.
 */
export async function markSyncBlocked(
    db: PrismaTx,
    connectionIds: string[],
    reason: string,
    now: Date = new Date(),
): Promise<number> {
    if (connectionIds.length === 0) return 0;
    const stored = reason.slice(0, MAX_REASON_LEN);

    // Only the FIRST observation moves the timestamp, so "blocked since" means
    // since — a dispatcher running `0 */4 * * *` would otherwise re-stamp it
    // every four hours and it would read as minutes old forever, which is the
    // one thing this field exists to tell an admin. A CHANGED reason does move
    // it: that is a different block, not the same one continuing.
    const r = await db.integrationConnection.updateMany({
        where: {
            id: { in: connectionIds },
            OR: [{ syncBlockedAt: null }, { syncBlockedReason: { not: stored } }],
        },
        data: { syncBlockedAt: now, syncBlockedReason: stored },
    });

    if (r.count > 0) {
        logger.warn('integration sync has no eligible actor — connections marked', {
            component: 'integrations',
            connections: r.count,
            reason,
        });
    }
    return r.count;
}

/**
 * Clear the block once a sync IS queued.
 *
 * Unconditional on every path that queues, for the reason `clearAuthFailure`
 * gives: a banner that outlives its cause is worse than none, because it teaches
 * people to ignore the one signal that means somebody must act. The `not: null`
 * predicate keeps the common case a no-op write.
 */
export async function clearSyncBlocked(
    db: PrismaTx,
    connectionIds: string[],
): Promise<number> {
    if (connectionIds.length === 0) return 0;

    const r = await db.integrationConnection.updateMany({
        where: { id: { in: connectionIds }, syncBlockedAt: { not: null } },
        data: { syncBlockedAt: null, syncBlockedReason: null },
    });

    if (r.count > 0) {
        logger.info('integration sync has an eligible actor again — connections cleared', {
            component: 'integrations',
            connections: r.count,
        });
    }
    return r.count;
}
