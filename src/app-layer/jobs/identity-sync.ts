/**
 * identity-sync jobs (PR-2).
 *
 *   - `identity-sync`          — sync ONE Okta / Google Workspace / Entra ID / Active Directory connection.
 *   - `identity-sync-dispatch` — daily fan-out: enqueue a sync for every
 *                                enabled identity connection across tenants.
 *
 * The per-connection worker delegates to the tenant-scoped
 * `runIdentitySync` usecase (no global prisma there). The dispatcher reads
 * only connection ids (not tenant content) via global prisma, mirroring
 * `sharepoint-delta-sync-dispatch`.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { enqueue } from './queue';
import { runIdentitySync, type IdentitySyncResult } from '@/app-layer/usecases/identity-sync';
import type { IdentitySyncPayload } from './types';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import { fanOut, dispatchJobId, DAILY_BUCKET_MS } from './fan-out';
import { runInTenantContext } from '@/lib/db-context';
import { buildSystemContext } from '@/app-layer/context-system';
import type { RequestContext } from '@/app-layer/types';
import { acquireSyncLock, releaseSyncLock } from '@/app-layer/integrations/connection-lock';
import {
    reconcileIdentityAccountLinks,
    type LinkMatchResult,
} from '@/app-layer/usecases/identity-account-link';
import { recordIdentityLinkReconcile } from '@/lib/observability/integration-metrics';

const IDENTITY_PROVIDERS = ['okta', 'google-workspace', 'entra-id', 'active-directory'];

export async function runIdentitySyncJob(payload: IdentitySyncPayload): Promise<IdentitySyncResult> {
    if (!payload.tenantId || !payload.connectionId) {
        throw new Error('identity-sync requires tenantId + connectionId');
    }
    // One sync at a time per connection. Two overlapping runs compute their
    // `seen` sets independently, and the deprovision reconcile from the run
    // that started EARLIER (`externalUserId: { notIn: seen }`) can flip accounts
    // the later run just upserted to DEPROVISIONED — the wrongful-mass-
    // deprovision hazard the truncation guard already worries about, arriving
    // through a different door.
    const ctx = buildSystemContext({ tenantId: payload.tenantId, job: 'identity-sync' });
    const token = await runInTenantContext(ctx, (db) =>
        acquireSyncLock(db, payload.connectionId!),
    );
    if (!token) {
        // Not a failure — another run is already doing exactly this work.
        return { executionId: '', status: 'SKIPPED', upserted: 0, deprovisioned: 0 };
    }

    try {
        // Returned whole rather than field-by-field. The old shim re-listed four
        // fields, so `errorMessage` and `noRetry` were silently dropped on the way
        // to the queue — the classification existed and never arrived.
        const result = await runIdentitySync({ tenantId: payload.tenantId, connectionId: payload.connectionId });
        await reconcileLinksAfterSync(ctx, result);
        return result;
    } finally {
        // `finally`, so a throw releases the lock rather than wedging the
        // connection until the lease expires.
        await runInTenantContext(ctx, (db) =>
            releaseSyncLock(db, payload.connectionId!, token),
        );
    }
}


/**
 * Re-observe which directory account belongs to which worker, after a sync that
 * enumerated the whole directory.
 *
 * ═══ WHY THIS HOOK EXISTS AT ALL ═══
 *
 * `reconcileIdentityAccountLinks` had no production caller. `IdentityAccountLink`
 * is therefore empty in the field, and `findLeaverCandidates` requires
 * `lastVerifiedAt >= staleBefore` — a column nothing else writes. So the leaver
 * candidate set was permanently empty, and a leaver pass shipped without this
 * would have run, reported success, and disabled nobody. That is worse than not
 * shipping it: an offboarding that silently does nothing looks exactly like an
 * offboarding that works.
 *
 * ═══ ONLY AFTER A CONFIRMED-COMPLETE ENUMERATION ═══
 *
 * Gated on the sync's own returned `status === 'PASSED'`, which is returned
 * ONLY from the arm that finished a full traversal. A resumable page-by-page run
 * returns `PARTIAL`; a directory past the enumeration cap returns `ERROR`.
 *
 * The distinction is the whole point. Matching is by email against the accounts
 * this tenant has on record, and an account absent from a TRUNCATED slice is
 * indistinguishable from one that no longer exists — so reconciling a partial
 * pass would stamp `lastVerifiedAt` on links whose accounts were never observed,
 * and mark others `contradictedAt` on the strength of a directory read that
 * never finished. Freshness would then certify a fact nobody checked, and the
 * rail whose whole job is to refuse a stale pairing would be attesting to one.
 *
 * ═══ WHY IT CANNOT FAIL THE SYNC ═══
 *
 * Its own try/catch. The sync genuinely succeeded — accounts were upserted and
 * deprovisioned — and reporting ERROR because a follow-on bookkeeping pass threw
 * would make the queue retry a full directory enumeration to fix a link table.
 * The failure is loud in the log and in `identity.link.reconcile{outcome=error}`
 * instead, which is where a stopped reconciler has to be visible: nothing else
 * downstream reports its absence, it just quietly yields no leaver candidates.
 *
 * Placed AFTER `runIdentitySync` returns rather than inside it, so it opens its
 * own `runInTenantContext` transaction instead of nesting one inside the sync's
 * — two held PgBouncer connections for one logical unit of work is how a
 * transaction-mode pooler runs out of them. Still inside the caller's `try`, so
 * it runs under the per-connection lock that a concurrent sync would otherwise
 * be free to interleave with.
 */
async function reconcileLinksAfterSync(
    ctx: RequestContext,
    result: IdentitySyncResult,
): Promise<void> {
    // No provider means the connection never resolved, so there was no
    // enumeration to reconcile against.
    if (!result.provider) return;
    if (result.status !== 'PASSED') {
        recordIdentityLinkReconcile({ provider: result.provider, outcome: 'skipped' });
        return;
    }
    try {
        const r = await reconcileIdentityAccountLinks(ctx, result.provider);
        recordIdentityLinkReconcile({ provider: result.provider, outcome: 'reconciled' });
        logger.info('identity link reconcile complete', {
            component: 'identity-sync',
            tenantId: ctx.tenantId,
            provider: result.provider,
            created: r.created,
            verified: r.verified,
            contradicted: r.contradicted,
            unmatched: r.unmatched,
        });
        await recordLinkReconcileOnExecution(ctx, result.executionId, result.provider, r);
    } catch (err) {
        recordIdentityLinkReconcile({ provider: result.provider, outcome: 'error' });
        logger.error('identity link reconcile failed; the sync itself succeeded', {
            component: 'identity-sync',
            tenantId: ctx.tenantId,
            provider: result.provider,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Carry the reconcile's own report onto the row the sync already wrote.
 *
 * WHY THIS EXISTS. `reconcileIdentityAccountLinks` names the accounts it could
 * not link and why — `NO_EMPLOYEE`, `AMBIGUOUS_EMPLOYEE`, `LINKED_ELSEWHERE`,
 * each wanting a different response. Its only caller logged the four COUNTS and
 * dropped the array, so the feature was defeated at its call site: "9 unmatched"
 * is exactly the unactionable number naming them was meant to replace, and an
 * account with no HR counterpart is one offboarding will never disable.
 *
 * WHY THE SYNC'S OWN EXECUTION ROW, NOT A SECOND ONE. `runIdentitySync` creates
 * exactly one `IntegrationExecution` per run and hands back its id, and the
 * reconcile is part of that run. A second row would double every connection's
 * history, and it would also land on the tenant-wide automated-checks list,
 * which is reachable with `controls.view` while the rest of this chain is
 * admin-gated — letting where-we-store-a-fact decide who-can-see-it.
 *
 * WHY THESE IDS MAY BE PERSISTED THOUGH THEY ARE NOT LOGGED.
 * `connectedAccountId` is our own cuid and `reason` is one of three fixed
 * literals, so neither can name a person — unlike a leaver decision's
 * provider-authored `reason` sentence, which has to be scrubbed. The
 * destination is a tenant-scoped, RLS-bound row read under admin permission,
 * which is precisely what a log line is not.
 *
 * READ-MODIFY-WRITE, because Prisma has no JSON merge and the sync's own
 * counters already occupy the column. Safe here and only here: the
 * per-connection sync lock is still held, and nothing else writes this row once
 * `runIdentitySync` has returned.
 */
async function recordLinkReconcileOnExecution(
    ctx: RequestContext,
    executionId: string,
    provider: string,
    r: LinkMatchResult,
): Promise<void> {
    // Defensive only. Every arm of `runIdentitySync` carries a real id, and this
    // is reached solely on PASSED — so this is a guard against a future arm, not
    // a case that exists today.
    if (!executionId) return;

    // Its own try/catch, deliberately NOT the caller's. The reconcile has
    // already happened and already counted itself `reconciled`; letting a failed
    // annotation fall through would emit `outcome: 'error'` for the same pass
    // immediately after, and one pass reported twice under contradictory
    // outcomes is worse than one whose report is missing.
    try {
        await runInTenantContext(ctx, async (db) => {
            const row = await db.integrationExecution.findFirst({
                where: { id: executionId, tenantId: ctx.tenantId },
                select: { resultJson: true },
            });
            if (!row) return;
            const prev = row.resultJson;
            // A Json column can hold a scalar or an array. Spreading either
            // would silently discard the sync's own counters, so anything that
            // is not a plain object is replaced rather than merged into.
            const base =
                prev !== null && typeof prev === 'object' && !Array.isArray(prev)
                    ? (prev as Record<string, unknown>)
                    : {};
            await db.integrationExecution.update({
                where: { id: executionId },
                data: {
                    resultJson: {
                        ...base,
                        linkReconcile: {
                            created: r.created,
                            verified: r.verified,
                            contradicted: r.contradicted,
                            unmatched: r.unmatched,
                            // Field by field rather than a spread, so a field
                            // added to `UnresolvedAccount` later is opted INTO a
                            // persisted row by a diff somebody reads, rather
                            // than swept into one.
                            unresolved: r.unresolved.map((u) => ({
                                connectedAccountId: u.connectedAccountId,
                                reason: u.reason,
                            })),
                            // DERIVED, not assumed. The sample is capped at
                            // MAX_UNRESOLVED_REPORTED while `unmatched` counts
                            // every one — `noteUnresolved` is the sole
                            // incrementer of both — so the two disagreeing IS
                            // the truncation signal. A short report says it is
                            // short, instead of reading as a complete list.
                            unresolvedTruncated: r.unresolved.length < r.unmatched,
                        },
                    },
                },
            });
        });
    } catch (err) {
        logger.error('link reconcile ran, but its report could not be recorded', {
            component: 'identity-sync',
            tenantId: ctx.tenantId,
            provider,
            executionId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/** Fan-out: one identity-sync per enabled Okta / Google Workspace connection. */
export async function runIdentitySyncDispatch(): Promise<{ connections: number; dispatched: number; failed: number }> {
    // Was `take: 1000` with no signal. Past the cap, tenants never synced and
    // the completion log still read like a clean success.
    const connections = await drainPages((cursor) =>
        prisma.integrationConnection.findMany({
            where: { provider: { in: IDENTITY_PROVIDERS }, isEnabled: true },
            select: { id: true, tenantId: true },
            orderBy: { id: 'asc' },
            take: DRAIN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
    );

    // Deterministic id per (connection, UTC day) so a dispatcher retry or a
    // redeploy replaying the schedule cannot queue a second full sync for every
    // connection; failures isolated so one bad enqueue does not silently drop
    // every connection behind it.
    const { dispatched, failed } = await fanOut(
        connections,
        'identity-sync',
        (conn) => ({ tenantId: conn.tenantId, connectionId: conn.id }),
        (conn) =>
            enqueue(
                'identity-sync',
                { tenantId: conn.tenantId, connectionId: conn.id },
                { jobId: dispatchJobId('identity-sync', conn.id, DAILY_BUCKET_MS) },
            ),
    );

    logger.info('identity-sync-dispatch complete', { component: 'identity-sync', connections: connections.length, dispatched, failed });

    // Nothing got out at all — reporting success would claim a clean run that
    // dispatched nothing.
    if (failed > 0 && dispatched === 0) {
        throw new Error(`identity-sync-dispatch: all ${failed} enqueues failed`);
    }
    return { connections: connections.length, dispatched, failed };
}
