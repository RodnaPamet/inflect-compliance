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
export async function clearAuthFailure(db: PrismaTx, connectionId: string): Promise<boolean> {
    const r = await db.integrationConnection.updateMany({
        where: { id: connectionId, authFailedAt: { not: null } },
        data: { authFailedAt: null, authFailureReason: null },
    });

    if (r.count > 0) {
        logger.info('integration credential recovered — connection cleared', {
            component: 'integrations',
            connectionId,
        });
    }
    return r.count > 0;
}
