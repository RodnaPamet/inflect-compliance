/**
 * The retention sweep must not visit a removed tenant (#3178).
 *
 * `runEvidenceRetentionNotifications` runs TWO `evidence.findMany` queries — the
 * expiring pass and the already-expired pass — and each was filtered only on
 * `Evidence.deletedAt`. A tenant soft-delete does not cascade to its rows, so
 * both predicates were satisfiable by evidence in a workspace that had been
 * removed, and with no `options.tenantId` (which is how the schedule runs it)
 * each query spans every tenant there is.
 *
 * WHY A MOCKED SUITE WHEN A REAL-DB ONE EXISTS. The behavioural proof lives in
 * `retention-notifications.test.ts`, where a removed tenant's expiring evidence
 * produces `scanned: 0` and no Task. That proof cannot reach the second query:
 * the expired pass returns nothing and creates nothing — its only effect is an
 * `EVIDENCE_EXPIRED` automation emit, which is fire-and-forget and a no-op with
 * no rules configured. So the only thing that can be asserted about its
 * predicate is the predicate, at the call site, which is what this does.
 *
 * Both queries return [] here deliberately: the job then does no further work,
 * so the mock stays the two methods under test rather than a reimplementation of
 * everything downstream.
 */
const evidenceFindMany = jest.fn(async (..._a: unknown[]) => [] as unknown[]);

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: { evidence: { findMany: (...a: unknown[]) => evidenceFindMany(...a) } },
    default: { evidence: { findMany: (...a: unknown[]) => evidenceFindMany(...a) } },
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runEvidenceRetentionNotifications } from '@/app-layer/jobs/retention-notifications';

type Where = {
    deletedAt?: unknown;
    tenantId?: string;
    tenant?: { deletedAt: null };
    retentionUntil?: unknown;
    expiredAt?: unknown;
};

/** The two passes, told apart by the field only each one filters on. */
function passes(): { expiring: Where; expired: Where } {
    const wheres = (evidenceFindMany.mock.calls as unknown as Array<[{ where: Where }]>)
        .map(c => c[0].where);
    const expiring = wheres.find(w => w.retentionUntil !== undefined);
    const expired = wheres.find(w => w.expiredAt !== undefined);
    if (!expiring || !expired) {
        throw new Error(
            `expected both passes; got ${wheres.length} queries: ${JSON.stringify(wheres)}`,
        );
    }
    return { expiring, expired };
}

beforeEach(() => {
    evidenceFindMany.mockClear();
});

describe('retention notifications: tenant liveness', () => {
    it('runs both passes — the population this suite asserts about', async () => {
        // An empty selection passes every assertion below by vacuity. If the job
        // stops issuing two queries, these tests must fail LOUDLY rather than
        // report a clean build; `passes()` throws, naming what it saw.
        await runEvidenceRetentionNotifications({});
        expect(evidenceFindMany).toHaveBeenCalledTimes(2);
        expect(() => passes()).not.toThrow();
    });

    it('the expiring pass requires a live tenant', async () => {
        await runEvidenceRetentionNotifications({});
        expect(passes().expiring.tenant).toEqual({ deletedAt: null });
    });

    /**
     * The pass the real-DB suite structurally cannot cover: it creates nothing,
     * so there is no row whose absence could carry the assertion.
     */
    it('the already-expired pass requires a live tenant too', async () => {
        await runEvidenceRetentionNotifications({});
        expect(passes().expired.tenant).toEqual({ deletedAt: null });
    });

    /**
     * `Evidence.deletedAt` and `Tenant.deletedAt` are different predicates, and
     * confusing them is the whole defect. Both must be present: dropping the
     * entity filter would resurrect deleted evidence, dropping the tenant filter
     * is #3178.
     */
    it('and keeps the entity filter — they are not interchangeable', async () => {
        await runEvidenceRetentionNotifications({});
        const { expiring, expired } = passes();
        expect(expiring.deletedAt).toBeNull();
        expect(expired.deletedAt).toBeNull();
    });

    /**
     * A manual invocation naming a removed tenant must not do by hand what the
     * schedule no longer does — the same reasoning as #3169's explicit-id branch.
     * The narrowing is ADDITIVE: `tenantId` does not replace the liveness filter.
     */
    it('an explicit tenantId is narrowed by liveness, not exempted from it', async () => {
        await runEvidenceRetentionNotifications({ tenantId: 't-removed' });
        const { expiring, expired } = passes();
        expect(expiring).toMatchObject({ tenantId: 't-removed', tenant: { deletedAt: null } });
        expect(expired).toMatchObject({ tenantId: 't-removed', tenant: { deletedAt: null } });
    });
});
