/**
 * The server half of the concurrent-run cap: read the ceiling, count what is
 * in flight, and refuse a run at the door (#3484).
 *
 * ## TWO CHECKS, ONE RULE — and why that is not duplication
 *
 * `assertWithinConcurrencyCap` is called at the top of `startWorkflowRun`,
 * beside the monthly budget: it is cheap, it refuses the overwhelming majority
 * of over-cap starts, and it does so before any work is done. But it CANNOT be
 * exact on its own. Two requests that both read "2 in flight, cap 3" both
 * proceed and the tenant ends at 4 — the overshoot the monthly budget's own
 * docblock describes and deliberately declines to fix, because for a monthly
 * budget the overshoot is bounded by one run's token cap and nobody is harmed.
 *
 * For a CONCURRENCY cap that argument does not hold. Simultaneous starts are
 * precisely the thing being bounded, so an overshoot proportional to
 * concurrent starts is an overshoot proportional to the attack. A cap that
 * admits 8 runs whenever 8 arrive together has not capped anything.
 *
 * So the exact gate is `assertConcurrencyUnderLock`, called INSIDE the
 * transaction that inserts the run row, after a per-tenant
 * `pg_advisory_xact_lock`. Concurrent starts for the SAME tenant serialise
 * there, each one sees the committed count, and the loser's transaction rolls
 * back — so no `WorkflowRun` row exists for a refused start. That matters for
 * the reason `createSealedRun`'s own comment gives: a refusal after the row
 * exists leaves a RUNNING run nothing will ever advance, which the settlement
 * sweep later reaps as a crashed executor.
 *
 * The lock releases at commit or rollback because it is an `xact` lock — no
 * release path to get wrong, which is the part the budget's note says "goes
 * wrong" about a reservation counter.
 *
 * ## What the lock costs
 *
 * It serialises CONCURRENT STARTS for one tenant, for the duration of one
 * count plus one insert inside a transaction that was already open. Different
 * tenants take different lock keys and do not contend. A tenant that starts
 * runs one at a time never waits.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { runInTenantContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { badRequest, forbidden } from '@/lib/errors/types';
import { assertAgentGovernanceAdmin } from '@/app-layer/policies/agent-governance.policies';
import { appendAuditEntry } from '@/lib/audit';
import type { RequestContext } from '@/app-layer/types';

import {
    evaluateConcurrency,
    concurrencyRefusalMessage,
    CONCURRENCY_CAP_SETTING_MESSAGE,
    isSettableConcurrencyCap,
    normaliseCap,
    LIVE_RUN_STATUSES,
    type ConcurrencyVerdict,
} from './run-concurrency';

/**
 * Count this tenant's runs that can still progress.
 *
 * The STATUS SET lives in `run-concurrency.ts` and is shared with the replay
 * tail, which decides whether to keep a stream open on exactly the same
 * question: can this run still produce steps? Two lists would drift, and the
 * drift would be invisible — a cap counting a status the tail considered
 * finished would refuse a tenant for a run nobody was watching progress.
 *
 * Read through `runInTenantContext`, so the count is RLS-scoped like every
 * other tenant read rather than relying on the WHERE clause alone.
 */
export async function inFlightRunCount(ctx: RequestContext): Promise<number> {
    return runInTenantContext(ctx, (tx) =>
        tx.workflowRun.count({
            where: { tenantId: ctx.tenantId, status: { in: [...LIVE_RUN_STATUSES] } },
        }),
    );
}

/** The configured cap, or null. A failed read resolves to NO CAP — see below. */
async function readCap(ctx: RequestContext): Promise<number | null> {
    try {
        const row = await prisma.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { agentMaxConcurrentRuns: true },
        });
        return row?.agentMaxConcurrentRuns ?? null;
    } catch (err) {
        // The same direction the column's own NULL takes, and the same
        // argument `evaluateMonthlyBudgetForRun` makes: this bounds something
        // already authorised, so an unreadable settings row must not become an
        // outage. The log line is what keeps that from being silent.
        logger.warn('run-concurrency: settings read failed, treating as no cap', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            requestId: ctx.requestId,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * Evaluate the cap for one prospective run. Never throws.
 *
 * The `evaluate` / `assert` split is the one `agent-registration-gate.ts`
 * draws: an operator surface can REPORT a tenant's headroom without a refusal
 * as a side effect, which is what `/agents/reports` wants.
 */
export async function evaluateConcurrencyForRun(
    ctx: RequestContext,
): Promise<ConcurrencyVerdict> {
    const cap = await readCap(ctx);
    // SHORT-CIRCUIT before the count, on the run-start hot path. Every tenant
    // has no cap until somebody sets one, so this is the common case, and
    // `inFlight: 0` here is the right answer to "does the cap refuse this run"
    // and a FALSE ZERO as a reported figure — the same caveat
    // `spentThisMonth` carries. A reporting caller wanting the real number
    // calls `inFlightRunCount` directly.
    if (cap === null) return evaluateConcurrency({ cap: null, inFlight: 0 });
    return evaluateConcurrency({ cap, inFlight: await inFlightRunCount(ctx) });
}

/**
 * The EARLY check: refuse before any work is done. Not exact — see the header.
 */
export async function assertWithinConcurrencyCap(
    ctx: RequestContext,
): Promise<ConcurrencyVerdict> {
    const verdict = await evaluateConcurrencyForRun(ctx);
    if (!verdict.allowed) {
        logger.warn('run-concurrency: run refused at the door', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            requestId: ctx.requestId,
            cap: verdict.cap,
            inFlight: verdict.inFlight,
        });
        throw forbidden(concurrencyRefusalMessage(verdict));
    }
    return verdict;
}

/**
 * The EXACT check, inside the transaction that will insert the run row.
 *
 * Takes a per-tenant advisory lock FIRST, so two concurrent starts for one
 * tenant serialise here and the second sees the first's committed row. The
 * lock is transaction-scoped: it releases at commit or rollback with no
 * release path to get wrong.
 *
 * `$executeRawUnsafe` with a bound parameter, which is the idiom
 * `audit-writer.ts` already uses for its per-tenant chain lock — `Unsafe`
 * names the API, not the call: the tenant id is a parameter, never
 * interpolated. `$queryRaw` cannot be used here at all, measured:
 * `pg_advisory_xact_lock` returns `void` and Prisma fails to deserialize a
 * void column.
 *
 * THE KEY IS NAMESPACED, and that is load-bearing rather than tidy.
 * `appendAuditEntry` locks on `hashtext(tenantId)` for the same tenant inside
 * its own transaction; sharing that key would couple every run start to every
 * audit append for that tenant, turning two independent serialisations into
 * one queue and inviting a lock-ordering deadlock the day a run start writes
 * an audit row inside its own transaction. The prefix keeps them disjoint.
 *
 * `hashtext` (32-bit) rather than `hashtextextended`, matching the existing
 * call sites. A hash collision would mean two unrelated tenants serialising
 * against each other — a latency cost, not a correctness one.
 */
export async function assertConcurrencyUnderLock(
    tx: PrismaTx,
    ctx: RequestContext,
    cap: number | null,
): Promise<void> {
    if (cap === null) return; // Nothing to serialise on.
    await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        `agent-run-start:${ctx.tenantId}`,
    );
    const inFlight = await tx.workflowRun.count({
        where: { tenantId: ctx.tenantId, status: { in: [...LIVE_RUN_STATUSES] } },
    });
    const verdict = evaluateConcurrency({ cap, inFlight });
    if (!verdict.allowed) {
        logger.warn('run-concurrency: refused under the start lock', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            requestId: ctx.requestId,
            cap: verdict.cap,
            inFlight: verdict.inFlight,
        });
        throw forbidden(concurrencyRefusalMessage(verdict));
    }
}

/** Re-exported so a caller needs one import for the pair. */
export { readCap as readConcurrencyCap };

/**
 * Set (or clear) the tenant's concurrent-run cap.
 *
 * `null` CLEARS the cap; `0` sets "no agentic run may start". The two are
 * different instructions and the API keeps them apart — see `normaliseCap`.
 *
 * Upserts, because `TenantSecuritySettings` is created lazily: a tenant that
 * has never changed a security setting has no row, and a bare `update` would
 * refuse the first cap anybody sets.
 *
 * AUDITED. This is an authority change — raising the cap admits more
 * concurrent agentic work, and dropping it to 0 stops a tenant's agents — so
 * it belongs in the hash-chained trail beside the kill switch rather than only
 * in a column. The row records BOTH values, because "who lowered it and from
 * what" is the question an incident review asks.
 */
export async function setConcurrencyCap(
    ctx: RequestContext,
    cap: number | null,
): Promise<{ cap: number | null }> {
    assertAgentGovernanceAdmin(ctx, 'agent_registry');
    // Refused with the rule and its limit as the MESSAGE, as the budget's
    // setter does, so whoever sent it reads the reason rather than a generic
    // validation failure (#4471). Before `normaliseCap`, which would floor a
    // fractional cap silently.
    if (!isSettableConcurrencyCap(cap)) throw badRequest(CONCURRENCY_CAP_SETTING_MESSAGE);
    const next = normaliseCap(cap);
    const previous = await readCap(ctx);

    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId: ctx.tenantId },
        create: { tenantId: ctx.tenantId, agentMaxConcurrentRuns: next },
        update: { agentMaxConcurrentRuns: next },
    });

    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: 'AGENT_CONCURRENCY_CAP_SET',
        entity: 'TenantSecuritySettings',
        entityId: ctx.tenantId,
        requestId: ctx.requestId,
        detailsJson: {
            // Both numbers. A row saying only the new value cannot answer "was
            // this a tightening or a widening", which is the first thing an
            // incident review asks.
            previousCap: previous,
            cap: next,
        },
    });
    return { cap: next };
}
