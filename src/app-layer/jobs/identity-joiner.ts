/**
 * The joiner pass, as scheduled work.
 *
 *   - `identity-joiner-pass`     — one pass for one (tenant, provider).
 *   - `identity-joiner-dispatch` — daily fan-out over every tenant that has an
 *                                  enabled writable directory connection.
 *
 * A deliberate mirror of `jobs/identity-leaver.ts`. The leaver had all four
 * pieces — IO caller, executor pair, schedule (the manual run route follows in
 * the route half of #2687) — and the joiner
 * had none of them, so `planJoinerPass` was a decision core nothing could reach
 * (#2687). Mirroring rather than inventing keeps one shape for the two halves of
 * JML, so an operator reading either one already knows the other.
 *
 * ═══ ONE DISPATCH PER DECISION — WHY attempts IS 1 ═══
 *
 * Set in `JOB_DEFAULTS`, and it is not rate-limit courtesy. A pass WRITES an
 * `IntegrationExecution` row carrying a decision per starter; BullMQ's queue
 * default is three exponential attempts, so an omitted entry would run the same
 * pass three times in ~35 seconds and mint three artefacts for one morning. An
 * operator counting DRY_RUN observations over the seven-day window would then be
 * counting retries. A failed pass is picked up by tomorrow's dispatch, and
 * nothing is lost by waiting: the pass is a pure read plus one insert, and the
 * roster is still there.
 *
 * ═══ THE UNIT IS (TENANT, PROVIDER) ═══
 *
 * Not per connection, for the reason the leaver gives: `ConnectedIdentityAccount`
 * rows are matched per directory, and the writer factory refuses outright when a
 * provider has two enabled connections. The dispatcher therefore dedupes to
 * distinct (tenantId, provider).
 *
 * The cross-tenant read selects ids and provider ONLY — no tenant content — which
 * is what makes it acceptable, exactly as in `identity-sync-dispatch` and
 * `identity-leaver-dispatch`.
 *
 * ═══ PROVIDER SCOPING IS A GATE, NOT A TIDY-UP ═══
 *
 * `provider: { in: [...WRITABLE_IDENTITY_PROVIDERS] }` is what keeps this fan-out
 * from enqueuing a joiner pass for every Okta and Google Workspace connection in
 * the estate — directories this product has no writer for and no joiner story
 * about. Drop it and the pass runs for providers whose `observedAddresses` read
 * means something different, silently widening the population the artefact
 * claims to cover.
 *
 * ONE test fails on that edit, not two, and knowing which one matters: deleting
 * the predicate reddens `reads only writable providers, and only enabled
 * connections` in `tests/unit/identity-joiner-dispatch.test.ts` and nothing
 * else (measured — 1 failed, 12 passed). The neighbouring case, `control — the
 * WHERE predicate is the WHOLE scope`, is DESIGNED to stay green: it hands the
 * fake an `okta` row the real predicate would never have returned and asserts it
 * IS forwarded, which is what proves no second in-code filter exists. Its own
 * comment says so. A reader who believed the old "two independent places" would
 * find the first failure, assume the second was covered, and stop — so the
 * sentence was worse than no sentence.
 *
 * @module jobs/identity-joiner
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { enqueue } from './queue';
import type { IdentityJoinerPassPayload } from './types';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import { fanOut, dispatchJobId, DAILY_BUCKET_MS } from './fan-out';
import {
    runIdentityJoinerPass,
    type JoinerPassResult,
} from '@/app-layer/usecases/identity-joiner-run';
import { WRITABLE_IDENTITY_PROVIDERS } from '@/app-layer/integrations/identity-writable-providers';

export async function runIdentityJoinerPassJob(
    payload: IdentityJoinerPassPayload,
): Promise<JoinerPassResult> {
    // Both required, and the throw is the point. A pass with no provider would
    // resolve `hasFreshLink` and `observedAddresses` against NO directory, and
    // report ALREADY_PROVISIONED / ACCOUNT_OBSERVED from a population that does
    // not correspond to any one connection.
    if (!payload.tenantId || !payload.provider) {
        throw new Error('identity-joiner-pass requires tenantId + provider');
    }
    return runIdentityJoinerPass({ tenantId: payload.tenantId, provider: payload.provider });
}

/** Fan-out: one joiner pass per (tenant, writable provider) with a live connection. */
export async function runIdentityJoinerDispatch(): Promise<{
    units: number;
    dispatched: number;
    failed: number;
}> {
    const connections = await drainPages((cursor) =>
        prisma.integrationConnection.findMany({
            where: { provider: { in: [...WRITABLE_IDENTITY_PROVIDERS] }, isEnabled: true },
            // Ids and provider only. No configJson, no secrets, no tenant
            // content — the read crosses tenants, so it carries nothing that
            // would matter if it were logged.
            select: { id: true, tenantId: true, provider: true },
            orderBy: { id: 'asc' },
            take: DRAIN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
    );

    // Distinct (tenant, provider). A tenant with two connections for one
    // provider is a case the writer factory refuses by name — dispatching twice
    // would produce the same refusal twice and nothing else.
    const units = new Map<string, { id: string; tenantId: string; provider: string }>();
    for (const c of connections) {
        const key = `${c.tenantId}:${c.provider}`;
        if (!units.has(key)) units.set(key, c);
    }
    const list = [...units.values()];

    const { dispatched, failed } = await fanOut(
        list,
        'identity-joiner-pass',
        (u) => ({ tenantId: u.tenantId, provider: u.provider }),
        (u) =>
            enqueue(
                'identity-joiner-pass',
                { tenantId: u.tenantId, provider: u.provider },
                {
                    // Deterministic per (tenant, provider, UTC day), so a
                    // dispatcher retry or a redeploy replaying the schedule
                    // cannot queue a second pass for the same day — which would
                    // mint a second artefact for one morning's decisions.
                    jobId: dispatchJobId(
                        'identity-joiner-pass',
                        `${u.tenantId}:${u.provider}`,
                        DAILY_BUCKET_MS,
                    ),
                },
            ),
    );

    logger.info('identity-joiner-dispatch complete', {
        component: 'identity-joiner',
        connections: connections.length,
        units: list.length,
        dispatched,
        failed,
    });

    if (failed > 0 && dispatched === 0) {
        throw new Error(`identity-joiner-dispatch: all ${failed} enqueues failed`);
    }
    return { units: list.length, dispatched, failed };
}
