/**
 * Audit Coherence S7 (2026-05-24) — unit tests for the overdue
 * escalation cron.
 *
 * Pure function-level tests. The Prisma seam + enqueueEmail seam are
 * both mocked so we can drive the candidate set deterministically
 * and assert per-row enqueue behaviour without touching a real DB.
 */

const enqueueEmailMock = jest.fn();
jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: (...a: unknown[]) => enqueueEmailMock(...a),
}));

import { processAccessReviewOverdueEscalation } from '@/app-layer/jobs/access-review-overdue-escalation';

type Candidate = {
    id: string;
    tenantId: string;
    name: string;
    dueAt: Date;
    reviewer: { email: string | null; name: string | null } | null;
    tenant: { slug: string };
    decisions: Array<{ id: string; decision: string | null }>;
    /**
     * Step 5a — CONNECTED_APP subjects. REQUIRED rather than optional, and
     * the job spreads it without a `?? []` fallback on purpose: a tolerant
     * spread would let the original defect back in silently. The job counted
     * member rows only, so a connected campaign reported zero pending and was
     * recorded as "every reviewer slot has a verdict" — never escalated. A
     * fixture that forgets this field now fails loudly instead.
     */
    connectedDecisions: Array<{ id: string; decision: string | null }>;
};

function makeDb(opts: {
    candidates: Candidate[];
    admins: Map<string, Array<{ email: string | null; name: string | null }>>;
}) {
    return {
        accessReview: {
            findMany: jest.fn().mockResolvedValue(opts.candidates),
        },
        tenantMembership: {
            findMany: jest.fn(
                async (args: {
                    where: { tenantId: { in: string[] } | string };
                }) => {
                    // Support both shapes — the bulk-load uses
                    // `{ in: [...] }`, anything else (legacy) is
                    // a single string.
                    const tenantIds =
                        typeof args.where.tenantId === 'object' &&
                        'in' in args.where.tenantId
                            ? args.where.tenantId.in
                            : [args.where.tenantId as string];
                    const out: Array<{
                        tenantId: string;
                        user: { email: string | null; name: string | null };
                    }> = [];
                    for (const t of tenantIds) {
                        for (const a of opts.admins.get(t) ?? []) {
                            out.push({ tenantId: t, user: a });
                        }
                    }
                    return out;
                },
            ),
        },
    };
}

describe('processAccessReviewOverdueEscalation', () => {
    const now = new Date('2026-05-24T10:00:00Z');
    const tenA = 'tenant-A';
    const tenB = 'tenant-B';

    beforeEach(() => {
        enqueueEmailMock.mockReset();
        enqueueEmailMock.mockImplementation(async () => ({ id: 'em-1' }));
    });

    function due(daysAgo: number): Date {
        return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    }

    function candidate(overrides: Partial<Candidate> & { id: string }): Candidate {
        return {
            tenantId: tenA,
            name: 'Q1 access review',
            dueAt: due(10),
            reviewer: { email: 'reviewer@a.test', name: 'Rev A' },
            tenant: { slug: 'acme' },
            decisions: [
                { id: 'd1', decision: null },
                { id: 'd2', decision: 'CONFIRM' },
            ],
            connectedDecisions: [],
            ...overrides,
        };
    }

    it('escalates a past-grace campaign to every active admin', async () => {
        const db = makeDb({
            candidates: [candidate({ id: 'rv-1' })],
            admins: new Map([
                [
                    tenA,
                    [
                        { email: 'owner@a.test', name: 'Owner A' },
                        { email: 'admin@a.test', name: 'Admin A' },
                    ],
                ],
            ]),
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await processAccessReviewOverdueEscalation(db as any, { now });

        expect(r.scanned).toBe(1);
        expect(r.enqueued).toBe(2);
        expect(r.skippedComplete).toBe(0);
        expect(enqueueEmailMock).toHaveBeenCalledTimes(2);

        const recipients = enqueueEmailMock.mock.calls.map((c) => c[1].toEmail);
        expect(new Set(recipients)).toEqual(
            new Set(['owner@a.test', 'admin@a.test']),
        );

        const call = enqueueEmailMock.mock.calls[0][1];
        expect(call.type).toBe('ACCESS_REVIEW_OVERDUE_ESCALATION');
        expect(call.entityId).toBe('rv-1');
        expect(call.payload.daysOverdue).toBe(10);
        expect(call.payload.pendingDecisions).toBe(1);
        expect(call.payload.totalDecisions).toBe(2);
        expect(call.payload.reviewerName).toBe('Rev A');
    });

    it('skips campaigns whose decisions all have verdicts', async () => {
        const db = makeDb({
            candidates: [
                candidate({
                    id: 'rv-1',
                    decisions: [
                        { id: 'd1', decision: 'CONFIRM' },
                        { id: 'd2', decision: 'REVOKE' },
                    ],
                }),
            ],
            admins: new Map([
                [tenA, [{ email: 'owner@a.test', name: 'Owner A' }]],
            ]),
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await processAccessReviewOverdueEscalation(db as any, { now });

        expect(r.scanned).toBe(1);
        expect(r.skippedComplete).toBe(1);
        expect(r.enqueued).toBe(0);
        expect(enqueueEmailMock).not.toHaveBeenCalled();
    });

    it('skips a tenant with no admin emails', async () => {
        const db = makeDb({
            candidates: [candidate({ id: 'rv-1' })],
            admins: new Map([[tenA, []]]),
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await processAccessReviewOverdueEscalation(db as any, { now });

        expect(r.skippedNoAdminEmail).toBe(1);
        expect(r.enqueued).toBe(0);
    });

    it('counts dedupe-hits as skippedDuplicate', async () => {
        enqueueEmailMock.mockImplementation(async () => null);
        const db = makeDb({
            candidates: [candidate({ id: 'rv-1' })],
            admins: new Map([
                [tenA, [{ email: 'owner@a.test', name: 'Owner A' }]],
            ]),
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await processAccessReviewOverdueEscalation(db as any, { now });

        expect(r.enqueued).toBe(0);
        expect(r.skippedDuplicate).toBe(1);
    });

    it('issues exactly one bulk admin lookup regardless of candidate count', async () => {
        const cs = [
            candidate({ id: 'rv-1' }),
            candidate({ id: 'rv-2', name: 'Q2 access review' }),
            candidate({ id: 'rv-3', name: 'Q3 access review' }),
        ];
        const db = makeDb({
            candidates: cs,
            admins: new Map([
                [tenA, [{ email: 'admin@a.test', name: 'Admin A' }]],
            ]),
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await processAccessReviewOverdueEscalation(db as any, { now });

        // Hoisted bulk load — one findMany for ALL tenants in the
        // candidate set. The candidate loop never queries the DB.
        expect(db.tenantMembership.findMany).toHaveBeenCalledTimes(1);
        // Three enqueue calls though — one per campaign.
        expect(enqueueEmailMock).toHaveBeenCalledTimes(3);
    });

    it('fans out per tenant on a multi-tenant sweep', async () => {
        const cs = [
            candidate({ id: 'rv-A', tenantId: tenA }),
            candidate({
                id: 'rv-B',
                tenantId: tenB,
                name: 'B campaign',
                tenant: { slug: 'beta' },
            }),
        ];
        const db = makeDb({
            candidates: cs,
            admins: new Map([
                [tenA, [{ email: 'admin@a.test', name: 'Admin A' }]],
                [
                    tenB,
                    [
                        { email: 'owner@b.test', name: 'Owner B' },
                        { email: 'admin@b.test', name: 'Admin B' },
                    ],
                ],
            ]),
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await processAccessReviewOverdueEscalation(db as any, { now });

        expect(r.scanned).toBe(2);
        expect(r.enqueued).toBe(3); // 1 (tenA) + 2 (tenB)
        // Hoisted bulk load — still ONE findMany even across tenants
        // (the where clause uses `tenantId: { in: [...] }`).
        expect(db.tenantMembership.findMany).toHaveBeenCalledTimes(1);
        const args = db.tenantMembership.findMany.mock.calls[0][0];
        const tenantClause = args.where.tenantId as { in: string[] };
        expect([...tenantClause.in].sort()).toEqual([tenA, tenB].sort());
    });

    it('respects the tenantId scope when supplied', async () => {
        const db = makeDb({
            candidates: [candidate({ id: 'rv-1' })],
            admins: new Map([
                [tenA, [{ email: 'admin@a.test', name: 'Admin A' }]],
            ]),
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await processAccessReviewOverdueEscalation(db as any, {
            now,
            tenantId: tenA,
        });

        const findManyArgs = db.accessReview.findMany.mock.calls[0][0];
        expect(findManyArgs.where.tenantId).toBe(tenA);
    });

    it('honours a custom escalationDays threshold', async () => {
        const db = makeDb({
            candidates: [candidate({ id: 'rv-1' })],
            admins: new Map([
                [tenA, [{ email: 'admin@a.test', name: 'Admin A' }]],
            ]),
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await processAccessReviewOverdueEscalation(db as any, {
            now,
            escalationDays: 14,
        });

        // The findMany cutoff should be 14 days back from `now`.
        const args = db.accessReview.findMany.mock.calls[0][0];
        const cutoff = args.where.dueAt.lt as Date;
        const expected = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        expect(cutoff.getTime()).toBe(expected.getTime());
    });

    /*
        #3178 — the candidate query must require a live tenant.

        `deletedAt: null` in that query is `AccessReview.deletedAt`. A tenant
        soft-delete does not cascade to its reviews, so an open overdue review in
        a removed workspace satisfied every other predicate — and without a
        `tenantId`, which is how the schedule runs this, the query spans every
        tenant.

        `resolveAdmins` then fans out to `TenantMembership` rows with
        `status: 'ACTIVE'` and `role: { in: ['OWNER', 'ADMIN'] }`, and those rows
        survive a tenant's removal: 88 of production's 105 ACTIVE memberships
        belong to the seven tenants removed in September. The result is
        overdue-review mail about a workspace gone from every surface the reader
        could use to check.

        ASSERTED ON THE QUERY, not on an outcome. The db is a mock, so the only
        thing that can distinguish "filtered" from "not filtered" is what was
        asked for — a mock returns whatever the fixture says regardless of the
        predicate, so an outcome-based assertion here would pass either way.
        Same reasoning as #3176's `deletedAt` call-site assertion.
    */
    describe('tenant liveness', () => {
        it('asks only for reviews whose tenant still exists', async () => {
            const db = makeDb({ candidates: [], admins: new Map() });

            await processAccessReviewOverdueEscalation(db as any, { now });

            expect(db.accessReview.findMany).toHaveBeenCalledTimes(1);
            const where = (db.accessReview.findMany.mock.calls[0][0] as {
                where: Record<string, unknown>;
            }).where;
            expect(where.tenant).toEqual({ deletedAt: null });
        });

        it('keeps the review-level filter too — they are different predicates', async () => {
            // Confusing `AccessReview.deletedAt` with `Tenant.deletedAt` is the
            // defect itself, so both have to be present. Dropping the first
            // resurrects deleted reviews; dropping the second is #3178.
            const db = makeDb({ candidates: [], admins: new Map() });

            await processAccessReviewOverdueEscalation(db as any, { now });

            const where = (db.accessReview.findMany.mock.calls[0][0] as {
                where: Record<string, unknown>;
            }).where;
            expect(where.deletedAt).toBeNull();
            expect(where.tenant).toEqual({ deletedAt: null });
        });

        it('an explicit tenantId is narrowed by liveness, not exempted from it', async () => {
            // A manual invocation naming a removed tenant must not do by hand
            // what the schedule no longer does (cf. #3169's explicit-id branch).
            const db = makeDb({ candidates: [], admins: new Map() });

            await processAccessReviewOverdueEscalation(db as any, { now, tenantId: 't-removed' });

            const where = (db.accessReview.findMany.mock.calls[0][0] as {
                where: Record<string, unknown>;
            }).where;
            expect(where).toMatchObject({ tenantId: 't-removed', tenant: { deletedAt: null } });
        });
    });
    // ─── Step 5a — CONNECTED_APP campaigns escalate too ───

    describe('Step 5a — connected campaigns are not invisible to escalation', () => {
        it('escalates a connected campaign whose subjects are undecided', async () => {
            // The defect: this job counted `decisions` only. A CONNECTED_APP
            // campaign has ZERO of those — its subjects are
            // AccessReviewConnectedDecision rows — so pendingCount was 0, the
            // job read that as "every reviewer slot has a verdict", and an
            // overdue campaign with every account untouched escalated to
            // nobody while incrementing the skipped-because-complete counter.
            const db = makeDb({
                candidates: [
                    candidate({
                        id: 'rv-connected',
                        decisions: [],
                        connectedDecisions: [
                            { id: 'c1', decision: null },
                            { id: 'c2', decision: null },
                        ],
                    }),
                ],
                admins: new Map([[tenA, [{ email: 'owner@a.test', name: 'Owner A' }]]]),
            });

            const r = await processAccessReviewOverdueEscalation(db as never, { now });

            expect(r.scanned).toBe(1);
            expect(r.skippedComplete).toBe(0);
            expect(r.enqueued).toBe(1);
            expect(enqueueEmailMock).toHaveBeenCalledTimes(1);
        });

        it('does NOT escalate a connected campaign whose subjects are all decided', async () => {
            // The other side of the same arithmetic. Without this, the test
            // above is satisfied by a job that escalates unconditionally.
            const db = makeDb({
                candidates: [
                    candidate({
                        id: 'rv-connected-done',
                        decisions: [],
                        connectedDecisions: [
                            { id: 'c1', decision: 'CONFIRM' },
                            { id: 'c2', decision: 'REVOKE' },
                        ],
                    }),
                ],
                admins: new Map([[tenA, [{ email: 'owner@a.test', name: 'Owner A' }]]]),
            });

            const r = await processAccessReviewOverdueEscalation(db as never, { now });

            expect(r.skippedComplete).toBe(1);
            expect(r.enqueued).toBe(0);
            expect(enqueueEmailMock).not.toHaveBeenCalled();
        });

        it('asks the database for connectedDecisions at all', async () => {
            // The arithmetic is only right if the rows were fetched. A select
            // that stops asking for them makes both assertions above pass
            // against an empty array forever — the same shape as the original
            // defect, and invisible.
            const db = makeDb({
                candidates: [candidate({ id: 'rv-1' })],
                admins: new Map([[tenA, [{ email: 'owner@a.test', name: 'Owner A' }]]]),
            });
            await processAccessReviewOverdueEscalation(db as never, { now });
            const select = db.accessReview.findMany.mock.calls[0][0].select;
            expect(select).toHaveProperty('connectedDecisions');
            expect(select.connectedDecisions.select).toMatchObject({ decision: true });
        });
    });

});
