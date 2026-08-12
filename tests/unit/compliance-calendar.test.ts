/**
 * Epic 49 — `getComplianceCalendarEvents` usecase tests.
 *
 * Verifies the unified-aggregation behaviour:
 *
 *   1. Each source contributes events with the right shape (category,
 *      type, entityType, href).
 *   2. Mixed sources merge into one chronologically-sorted stream.
 *   3. Status classification is correct (scheduled/due_soon/overdue/done).
 *   4. Duration events (audit-cycle) carry both `date` and `end`.
 *   5. The type / category filters narrow the output.
 *   6. Tenant filter is applied to every Prisma call (regression guard).
 *   7. The empty-range case returns zero events without throwing.
 *   8. The badge count helper short-circuits at 99+.
 */

export {};

const TENANT_ID = 'tenant-1';
const TENANT_SLUG = 'acme';
const OWNER = 'user-owner';

// ─── Mocks ────────────────────────────────────────────────────────────

const mockEvidenceFindMany = jest.fn();
const mockPolicyFindMany = jest.fn();
const mockVendorFindMany = jest.fn();
const mockVendorDocFindMany = jest.fn();
const mockAuditCycleFindMany = jest.fn();
const mockControlFindMany = jest.fn();
const mockTestPlanFindMany = jest.fn();
const mockTaskFindMany = jest.fn();
const mockRiskFindMany = jest.fn();
const mockFindingFindMany = jest.fn();

const mockTreatmentMilestoneFindMany = jest.fn();
const mockTreatmentPlanFindMany = jest.fn();

// Sources added when the calendar stopped omitting deadline-bearing
// entities that already had reminder jobs.
const mockAccessReviewFindMany = jest.fn();
const mockTrainingFindMany = jest.fn();
const mockIncidentNotificationFindMany = jest.fn();
const mockControlExceptionFindMany = jest.fn();
const mockVendorAssessmentFindMany = jest.fn();

const mockTaskCount = jest.fn().mockResolvedValue(0);
const mockControlCount = jest.fn().mockResolvedValue(0);
const mockEvidenceCount = jest.fn().mockResolvedValue(0);
const mockPolicyCount = jest.fn().mockResolvedValue(0);
const mockVendorCount = jest.fn().mockResolvedValue(0);

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    [
        mockEvidenceFindMany,
        mockPolicyFindMany,
        mockVendorFindMany,
        mockVendorDocFindMany,
        mockAuditCycleFindMany,
        mockControlFindMany,
        mockTestPlanFindMany,
        mockTaskFindMany,
        mockRiskFindMany,
        mockFindingFindMany,
        mockTreatmentMilestoneFindMany,
        mockTreatmentPlanFindMany,
        mockAccessReviewFindMany,
        mockTrainingFindMany,
        mockIncidentNotificationFindMany,
        mockControlExceptionFindMany,
        mockVendorAssessmentFindMany,
    ].forEach((m) => m.mockReset().mockResolvedValue([]));
    [
        mockTaskCount,
        mockControlCount,
        mockEvidenceCount,
        mockPolicyCount,
        mockVendorCount,
    ].forEach((m) => m.mockReset().mockResolvedValue(0));

    // Calendar usecase reads via `runInTenantContext(ctx, db => ...)`
    // (passes through RLS-bound `app_user`). Mock the helper to invoke
    // the callback with our spy db immediately — equivalent to the
    // single-pass, no-actual-tx test path.
    const mockDb = {
        evidence: {
            findMany: (...a: unknown[]) => mockEvidenceFindMany(...a),
            count: (...a: unknown[]) => mockEvidenceCount(...a),
        },
        policy: {
            findMany: (...a: unknown[]) => mockPolicyFindMany(...a),
            count: (...a: unknown[]) => mockPolicyCount(...a),
        },
        vendor: {
            findMany: (...a: unknown[]) => mockVendorFindMany(...a),
            count: (...a: unknown[]) => mockVendorCount(...a),
        },
        vendorDocument: {
            findMany: (...a: unknown[]) => mockVendorDocFindMany(...a),
        },
        auditCycle: {
            findMany: (...a: unknown[]) => mockAuditCycleFindMany(...a),
        },
        control: {
            findMany: (...a: unknown[]) => mockControlFindMany(...a),
            count: (...a: unknown[]) => mockControlCount(...a),
        },
        controlTestPlan: {
            findMany: (...a: unknown[]) => mockTestPlanFindMany(...a),
        },
        task: {
            findMany: (...a: unknown[]) => mockTaskFindMany(...a),
            count: (...a: unknown[]) => mockTaskCount(...a),
        },
        risk: {
            findMany: (...a: unknown[]) => mockRiskFindMany(...a),
        },
        finding: {
            findMany: (...a: unknown[]) => mockFindingFindMany(...a),
        },
        // Epic G-7
        treatmentMilestone: {
            findMany: (...a: unknown[]) => mockTreatmentMilestoneFindMany(...a),
        },
        riskTreatmentPlan: {
            findMany: (...a: unknown[]) => mockTreatmentPlanFindMany(...a),
        },
        accessReview: {
            findMany: (...a: unknown[]) => mockAccessReviewFindMany(...a),
        },
        trainingAssignment: {
            findMany: (...a: unknown[]) => mockTrainingFindMany(...a),
        },
        incidentNotification: {
            findMany: (...a: unknown[]) => mockIncidentNotificationFindMany(...a),
        },
        controlException: {
            findMany: (...a: unknown[]) => mockControlExceptionFindMany(...a),
        },
        vendorAssessment: {
            findMany: (...a: unknown[]) => mockVendorAssessmentFindMany(...a),
        },
    };
    const invokeWithDb = async (
        _ctx: unknown,
        fn: (db: unknown) => Promise<unknown>,
    ) => fn(mockDb);
    jest.mock('@/lib/db-context', () => ({
        __esModule: true,
        // The badge count runs on the primary; every calendar source loader
        // now runs in its OWN read context. Both invoke the callback with the
        // spy db immediately (single-pass, no real tx).
        runInTenantContext: jest.fn(invokeWithDb),
        runInTenantReadContext: jest.fn(invokeWithDb),
    }));
});

/** A full-access PermissionSet — every source's `.view` is granted so the
 *  per-source permission gate lets all loaders run. Individual tests that
 *  exercise the gate build their own restricted set. */
function allPermissions(): unknown {
    const view = (extra: Record<string, boolean> = {}) => ({ view: true, ...extra });
    return {
        controls: view({ create: true, edit: true }),
        evidence: view({ upload: true, edit: true, download: true }),
        policies: view({ create: true, edit: true, approve: true }),
        tasks: view({ create: true, edit: true, assign: true }),
        risks: view({ create: true, edit: true }),
        assets: view({ create: true, edit: true }),
        vendors: view({ create: true, edit: true }),
        tests: view({ create: true, execute: true }),
        incidents: view({ manage: true }),
        personnel: view({ manage: true }),
        frameworks: view({ install: true }),
        audits: view({ manage: true, freeze: true, share: true }),
        reports: view({ export: true }),
        admin: {
            view: true, manage: true, members: true, sso: true, scim: true,
            tenant_lifecycle: true, owner_management: true,
            compliance_dsar_view: true, compliance_dsar_manage: true,
        },
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function makeCtx() {
    return {
        requestId: 'req-1',
        userId: 'user-1',
        tenantId: TENANT_ID,
        tenantSlug: TENANT_SLUG,
        role: 'EDITOR',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        },
        appPermissions: allPermissions(),
    };
}

const NOW = new Date('2026-06-01T00:00:00Z');
const FROM = new Date('2026-05-01T00:00:00Z');
const TO = new Date('2026-08-01T00:00:00Z');

// ─── Test cases ──────────────────────────────────────────────────────

describe('getComplianceCalendarEvents — aggregation', () => {
    it('returns an empty stream when every source is empty', async () => {
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const result = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(result.events).toEqual([]);
        expect(result.counts.total).toBe(0);
    });

    it('always filters every Prisma query by tenantId (defense-in-depth)', async () => {
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        for (const m of [
            mockEvidenceFindMany,
            mockPolicyFindMany,
            mockVendorFindMany,
            mockVendorDocFindMany,
            mockAuditCycleFindMany,
            mockControlFindMany,
            mockTestPlanFindMany,
            mockTaskFindMany,
            mockRiskFindMany,
            mockFindingFindMany,
            mockTreatmentMilestoneFindMany,
            mockTreatmentPlanFindMany,
        ]) {
            expect(m).toHaveBeenCalled();
            const call = m.mock.calls[0][0] as { where: { tenantId: string } };
            expect(call.where.tenantId).toBe(TENANT_ID);
        }
    });

    it('normalises mixed-source events into one stream sorted by date', async () => {
        mockEvidenceFindMany.mockResolvedValue([
            {
                id: 'ev-1',
                title: 'SOC2 Evidence',
                nextReviewDate: new Date('2026-06-15T00:00:00Z'),
                status: 'SUBMITTED',
                ownerUserId: OWNER,
            },
        ]);
        mockPolicyFindMany.mockResolvedValue([
            {
                id: 'pol-1',
                title: 'Acceptable Use',
                nextReviewAt: new Date('2026-05-20T00:00:00Z'),
                status: 'PUBLISHED',
            },
        ]);
        mockTaskFindMany.mockResolvedValue([
            {
                id: 'task-1',
                title: 'Review access logs',
                dueAt: new Date('2026-07-01T00:00:00Z'),
                status: 'OPEN',
                assigneeUserId: OWNER,
            },
        ]);

        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const result = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });

        expect(result.events).toHaveLength(3);
        expect(result.events.map((e) => e.type)).toEqual([
            'policy-review',
            'evidence-review',
            'task-due',
        ]);
        expect(result.counts.total).toBe(3);
        expect(result.counts.byCategory.policy).toBe(1);
        expect(result.counts.byCategory.evidence).toBe(1);
        expect(result.counts.byCategory.task).toBe(1);
    });

    it('classifies status correctly: overdue vs due_soon vs scheduled', async () => {
        mockTaskFindMany.mockResolvedValue([
            {
                id: 't-overdue',
                title: 'past',
                dueAt: new Date('2026-05-15T00:00:00Z'), // pre-now
                status: 'OPEN',
                assigneeUserId: null,
            },
            {
                id: 't-soon',
                title: 'in 5 days',
                dueAt: new Date('2026-06-06T00:00:00Z'), // +5d
                status: 'OPEN',
                assigneeUserId: null,
            },
            {
                id: 't-far',
                title: 'in 40 days',
                dueAt: new Date('2026-07-15T00:00:00Z'),
                status: 'OPEN',
                assigneeUserId: null,
            },
            {
                id: 't-done',
                title: 'closed',
                dueAt: new Date('2026-06-15T00:00:00Z'),
                status: 'CLOSED',
                assigneeUserId: null,
            },
        ]);
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const result = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        const byId = Object.fromEntries(
            result.events.map((e) => [e.entityId, e.status]),
        );
        expect(byId['t-overdue']).toBe('overdue');
        expect(byId['t-soon']).toBe('due_soon');
        expect(byId['t-far']).toBe('scheduled');
        expect(byId['t-done']).toBe('done');
    });

    it('emits audit cycles with both `date` and `end` (duration shape)', async () => {
        mockAuditCycleFindMany.mockResolvedValue([
            {
                id: 'cyc-1',
                name: 'Q3 SOC2',
                frameworkKey: 'SOC2',
                periodStartAt: new Date('2026-06-01T00:00:00Z'),
                periodEndAt: new Date('2026-08-31T00:00:00Z'),
                status: 'IN_PROGRESS',
            },
        ]);
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const result = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(result.events).toHaveLength(1);
        const ev = result.events[0];
        expect(ev.type).toBe('audit-cycle');
        expect(ev.category).toBe('audit');
        expect(ev.date).toBe('2026-06-01T00:00:00.000Z');
        expect(ev.end).toBe('2026-08-31T00:00:00.000Z');
        expect(ev.href).toBe('/t/acme/audits/cycles/cyc-1');
    });

    it('vendor returns BOTH a review event AND a renewal event when both dates fall in range', async () => {
        mockVendorFindMany.mockResolvedValue([
            {
                id: 'v-1',
                name: 'AWS',
                nextReviewAt: new Date('2026-06-10T00:00:00Z'),
                contractRenewalAt: new Date('2026-07-15T00:00:00Z'),
                status: 'ACTIVE',
                ownerUserId: OWNER,
            },
        ]);
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const result = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(result.events.map((e) => e.type)).toEqual([
            'vendor-review',
            'vendor-renewal',
        ]);
    });

    it('applies the `types` filter to narrow results post-aggregation', async () => {
        mockEvidenceFindMany.mockResolvedValue([
            {
                id: 'ev-1',
                title: 'X',
                nextReviewDate: new Date('2026-06-15T00:00:00Z'),
                status: 'SUBMITTED',
                ownerUserId: null,
            },
        ]);
        mockTaskFindMany.mockResolvedValue([
            {
                id: 't-1',
                title: 'Y',
                dueAt: new Date('2026-06-15T00:00:00Z'),
                status: 'OPEN',
                assigneeUserId: null,
            },
        ]);

        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const result = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
            types: ['task-due'],
        });
        expect(result.events).toHaveLength(1);
        expect(result.events[0].type).toBe('task-due');
    });

    it('embeds tenantSlug into the href so client navigation works without slug plumbing', async () => {
        mockTaskFindMany.mockResolvedValue([
            {
                id: 't-1',
                title: 'a',
                dueAt: new Date('2026-06-15T00:00:00Z'),
                status: 'OPEN',
                assigneeUserId: null,
            },
        ]);
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const result = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(result.events[0].href).toBe('/t/acme/tasks/t-1');
    });
});

describe('getUpcomingDeadlineCount — sidebar "Time" badge', () => {
    it('counts only the caller\'s future tasks and caps at 99+', async () => {
        // Non-task sources must NOT contribute — the badge is tasks-only now.
        mockTaskCount.mockResolvedValue(120);
        mockControlCount.mockResolvedValue(40);
        mockEvidenceCount.mockResolvedValue(20);
        const { getUpcomingDeadlineCount } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const count = await getUpcomingDeadlineCount(makeCtx() as never);
        // 120 tasks → capped at 100 (MAX_BADGE_COUNT + 1); controls/evidence ignored.
        expect(count).toBe(100);
    });

    it('returns the real task total when below the cap', async () => {
        mockTaskCount.mockResolvedValue(3);
        mockControlCount.mockResolvedValue(2); // ignored
        mockEvidenceCount.mockResolvedValue(1); // ignored
        const { getUpcomingDeadlineCount } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const count = await getUpcomingDeadlineCount(makeCtx() as never);
        expect(count).toBe(3);
    });

    it('INCLUDES overdue — the badge means "needs attention", not "upcoming"', async () => {
        // Regression: the badge used to filter `dueAt > now`, so a user
        // whose work was ENTIRELY late saw an empty badge — the worst
        // state rendered as the calmest. There must be no lower bound.
        mockTaskCount.mockResolvedValue(5);
        const { getUpcomingDeadlineCount } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        await getUpcomingDeadlineCount(makeCtx() as never, { now: NOW });
        const where = mockTaskCount.mock.calls[0][0].where;
        expect(where.assigneeUserId).toBe('user-1');
        expect(where.dueAt).toEqual({ not: null });
        // No lower bound of any kind — overdue tasks are in scope.
        expect(where.dueAt.gt).toBeUndefined();
        expect(where.dueAt.gte).toBeUndefined();
        // Non-task sources are never queried for the badge — its scope is
        // deliberately "my tasks", which the nav labels explicitly.
        expect(mockControlCount).not.toHaveBeenCalled();
        expect(mockEvidenceCount).not.toHaveBeenCalled();
        expect(mockPolicyCount).not.toHaveBeenCalled();
        expect(mockVendorCount).not.toHaveBeenCalled();
    });

    it('horizonDays caps the FUTURE side only, still counting overdue', async () => {
        mockTaskCount.mockResolvedValue(2);
        const { getUpcomingDeadlineCount } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        await getUpcomingDeadlineCount(makeCtx() as never, { now: NOW, horizonDays: 7 });
        const horizon = new Date(NOW.getTime() + 7 * 86_400_000);
        const where = mockTaskCount.mock.calls[0][0].where;
        expect(where.dueAt.lte).toEqual(horizon);
        // An old overdue task doesn't stop needing attention because the
        // caller asked for a 7-day view.
        expect(where.dueAt.gt).toBeUndefined();
        expect(where.dueAt.gte).toBeUndefined();
    });
});

// ─── Ordered truncation + the shared evidence-expiry predicate ────────

describe('per-source truncation keeps the NEAREST deadlines', () => {
    /**
     * The per-source cap without an ORDER BY was silently arbitrary: the
     * planner returned whatever 500 rows it liked, so a busy tenant could
     * lose precisely the deadlines it most needed to see. Every loader must
     * therefore order ascending by the date column it ranges on.
     */
    const ORDERED_SOURCES: ReadonlyArray<[string, () => jest.Mock, string]> = [
        ['evidence', () => mockEvidenceFindMany, 'nextReviewDate'],
        ['policy', () => mockPolicyFindMany, 'nextReviewAt'],
        ['vendorDocument', () => mockVendorDocFindMany, 'validTo'],
        ['control', () => mockControlFindMany, 'nextDueAt'],
        ['controlTestPlan', () => mockTestPlanFindMany, 'nextDueAt'],
        ['task', () => mockTaskFindMany, 'dueAt'],
        ['finding', () => mockFindingFindMany, 'dueDate'],
        ['accessReview', () => mockAccessReviewFindMany, 'dueAt'],
        ['trainingAssignment', () => mockTrainingFindMany, 'dueAt'],
        ['incidentNotification', () => mockIncidentNotificationFindMany, 'dueAt'],
        ['controlException', () => mockControlExceptionFindMany, 'expiresAt'],
        ['vendorAssessment', () => mockVendorAssessmentFindMany, 'nextReviewAt'],
        ['treatmentMilestone', () => mockTreatmentMilestoneFindMany, 'dueDate'],
        ['riskTreatmentPlan', () => mockTreatmentPlanFindMany, 'targetDate'],
    ];

    it.each(ORDERED_SOURCES)(
        '%s orders ascending by %s so a cap keeps the soonest',
        async (_name, getMock, dateField) => {
            const { getComplianceCalendarEvents } = await import(
                '@/app-layer/usecases/compliance-calendar'
            );
            await getComplianceCalendarEvents(makeCtx() as never, {
                from: FROM,
                to: TO,
                now: NOW,
            });
            const args = getMock().mock.calls[0][0];
            expect(args.orderBy).toBeDefined();
            expect(args.take).toBeGreaterThan(0);
            // Single-column sources order on their date column directly;
            // two-date sources (vendor, risk, auditCycle) pass an array and
            // are asserted separately below.
            expect(args.orderBy).toEqual({ [dateField]: 'asc' });
        },
    );

    it('multi-date sources query each date column separately, ascending', async () => {
        // A single `orderBy: [a, b]` truncates rows matching only on `b`
        // first (Postgres NULLS LAST), the OPPOSITE of "nearest survive".
        // Each column is queried on its own ascending order and unioned.
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        // Vendor: review + renewal, one query each.
        expect(mockVendorFindMany).toHaveBeenCalledTimes(2);
        expect(mockVendorFindMany.mock.calls.map((c) => c[0].orderBy)).toEqual(
            expect.arrayContaining([
                { nextReviewAt: 'asc' },
                { contractRenewalAt: 'asc' },
            ]),
        );
        // Risk: review + target.
        expect(mockRiskFindMany).toHaveBeenCalledTimes(2);
        expect(mockRiskFindMany.mock.calls.map((c) => c[0].orderBy)).toEqual(
            expect.arrayContaining([
                { nextReviewAt: 'asc' },
                { targetDate: 'asc' },
            ]),
        );
        // Audit cycle: starts-in, ends-in, straddling — three intersections.
        expect(mockAuditCycleFindMany).toHaveBeenCalledTimes(3);
        expect(
            mockAuditCycleFindMany.mock.calls.map((c) => c[0].orderBy),
        ).toEqual(
            expect.arrayContaining([
                { periodStartAt: 'asc' },
                { periodEndAt: 'asc' },
            ]),
        );
        // Every audit-cycle sub-query still scopes tenant + soft-delete.
        for (const call of mockAuditCycleFindMany.mock.calls) {
            expect(call[0].where.tenantId).toBe(TENANT_ID);
            expect(call[0].where.deletedAt).toBeNull();
        }
    });

    it('control-test-plan reads BOTH due clocks (effective = min)', async () => {
        // The MANUAL path advances only `nextRunAt`, so reading `nextDueAt`
        // alone renders cron-scheduled plans permanently overdue. The loader
        // queries each clock and emits at the earliest.
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(mockTestPlanFindMany).toHaveBeenCalledTimes(2);
        const orderBys = mockTestPlanFindMany.mock.calls.map((c) => c[0].orderBy);
        expect(orderBys).toEqual(
            expect.arrayContaining([{ nextDueAt: 'asc' }, { nextRunAt: 'asc' }]),
        );
    });

    it('reports the capped source instead of silently under-reporting', async () => {
        // A source that returns exactly `perSourceLimit` rows has almost
        // certainly got more behind the cap.
        mockTaskFindMany.mockResolvedValue(
            Array.from({ length: 3 }, (_, i) => ({
                id: `t${i}`,
                title: `Task ${i}`,
                dueAt: new Date('2026-06-10T00:00:00Z'),
                status: 'OPEN',
                assigneeUserId: null,
            })),
        );
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const res = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
            perSourceLimit: 3,
        });
        expect(res.truncation.capped).toBe(true);
        expect(res.truncation.sources).toContain('task');
        expect(res.truncation.perSourceLimit).toBe(3);
        // The summary must not present a post-truncation count as complete.
        expect(res.counts.partial).toBe(true);
    });

    it('reports no truncation when every source is under its cap', async () => {
        mockTaskFindMany.mockResolvedValue([
            {
                id: 't1',
                title: 'Task',
                dueAt: new Date('2026-06-10T00:00:00Z'),
                status: 'OPEN',
                assigneeUserId: null,
            },
        ]);
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const res = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
            perSourceLimit: 500,
        });
        expect(res.truncation.capped).toBe(false);
        expect(res.truncation.sources).toEqual([]);
        expect(res.counts.partial).toBe(false);
    });
});

describe('evidence expiry uses the one shared predicate', () => {
    it('the calendar loader excludes soft-deleted + archived evidence', async () => {
        // Regression: the calendar had no deletedAt/isArchived guard at
        // all, so it showed review deadlines for evidence the rest of the
        // product treats as gone — phantom reviews.
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        const where = mockEvidenceFindMany.mock.calls[0][0].where;
        expect(where.deletedAt).toBeNull();
        expect(where.isArchived).toBe(false);
        expect(where.tenantId).toBe(TENANT_ID);
    });

    it('the shared scope predicate is what the calendar and dashboard both spread', async () => {
        const { evidenceExpiryScopeWhere } = await import(
            '@/app-layer/domain/evidence-expiry'
        );
        expect(evidenceExpiryScopeWhere(TENANT_ID)).toEqual({
            tenantId: TENANT_ID,
            deletedAt: null,
            isArchived: false,
        });
    });
});

// ─── Per-source permission gating (the cross-entity-leak fix) ─────────

describe('per-source permission gating', () => {
    /** A ctx whose appPermissions grants ONLY the listed domain `.view`s. */
    function ctxWithViews(...domains: string[]) {
        const base = allPermissions() as Record<string, Record<string, boolean>>;
        const denied: Record<string, Record<string, boolean>> = {};
        for (const [domain, actions] of Object.entries(base)) {
            denied[domain] = Object.fromEntries(
                Object.keys(actions).map((a) => [a, false]),
            );
        }
        for (const d of domains) if (denied[d]) denied[d].view = true;
        return { ...makeCtx(), appPermissions: denied };
    }

    it('runs ONLY the sources the caller is permitted to see', async () => {
        mockTaskFindMany.mockResolvedValue([
            { id: 't1', title: 'a', dueAt: new Date('2026-06-15T00:00:00Z'), status: 'OPEN', assigneeUserId: null },
        ]);
        // A tenant member whose custom role holds ONLY tasks.view.
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const res = await getComplianceCalendarEvents(ctxWithViews('tasks') as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        // The permitted source ran…
        expect(mockTaskFindMany).toHaveBeenCalled();
        // …and every denied source was NEVER queried (no cross-entity leak).
        expect(mockTrainingFindMany).not.toHaveBeenCalled();
        expect(mockIncidentNotificationFindMany).not.toHaveBeenCalled();
        expect(mockVendorFindMany).not.toHaveBeenCalled();
        expect(mockRiskFindMany).not.toHaveBeenCalled();
        expect(mockPolicyFindMany).not.toHaveBeenCalled();
        // The response tells the UI which sources were hidden by permission.
        expect(res.omittedSources).toContain('training');
        expect(res.omittedSources).toContain('incident-notification');
        expect(res.omittedSources).toContain('vendor');
        expect(res.omittedSources).not.toContain('task');
        // Only task events survive.
        expect(res.events.map((e) => e.type)).toEqual(['task-due']);
    });

    it('a caller with NO view permissions sees an empty, fully-omitted calendar', async () => {
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const res = await getComplianceCalendarEvents(ctxWithViews() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        expect(res.events).toEqual([]);
        // Every source is reported as omitted, not silently absent.
        expect(res.omittedSources.length).toBeGreaterThan(0);
        expect(mockTaskFindMany).not.toHaveBeenCalled();
        expect(mockVendorFindMany).not.toHaveBeenCalled();
    });

    it('exposes a non-empty baseline permission set for the route gate', async () => {
        const { CALENDAR_BASELINE_PERMISSIONS } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        expect(CALENDAR_BASELINE_PERMISSIONS.length).toBeGreaterThan(0);
        // The baseline is the distinct set of the per-source domains, so it
        // includes the sensitive ones the leak exposed.
        expect(CALENDAR_BASELINE_PERMISSIONS).toEqual(
            expect.arrayContaining(['incidents.view', 'personnel.view', 'tasks.view']),
        );
    });
});

// ─── Deadline ownership + the control test clock ─────────────────────
//
// Two defect classes, both of which made the product state something false
// about a deadline:
//
//   - "My deadlines" (`CalendarClient` filters `ownerUserId === currentUserId`)
//     silently dropped whole domains, because eleven of the seventeen loaders
//     never selected an owner column that existed on the model. A source that
//     emits no `ownerUserId` does not render as "unowned" — it vanishes.
//   - the control loader called an IMPLEMENTED control's lapsed TEST `done`,
//     while `deadline-monitor` emailed the very same row as overdue.
//
// These assert the emitted event, not the shape of the select, because a
// select assertion passes while the value never reaches the DTO.

describe('calendar event ownership', () => {
    /** Pull one event of a given type out of a full aggregation. */
    async function eventOfType(type: string) {
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const res = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        return res.events.find((e) => e.type === type);
    }

    const IN_RANGE = new Date('2026-06-15T00:00:00Z');

    it('a risk owner can see their risk review AND mitigation target', async () => {
        mockRiskFindMany.mockResolvedValue([
            {
                id: 'risk-1',
                title: 'Vendor concentration',
                nextReviewAt: IN_RANGE,
                targetDate: IN_RANGE,
                status: 'OPEN',
                ownerUserId: OWNER,
            },
        ]);
        // Both of the risk loader's event types must carry it — the loader
        // emits two events from one row and only one of them used to be
        // considered when reasoning about this filter.
        expect((await eventOfType('risk-review'))?.ownerUserId).toBe(OWNER);
        expect((await eventOfType('risk-target'))?.ownerUserId).toBe(OWNER);
    });

    it('a treatment-plan target carries its owner', async () => {
        mockTreatmentPlanFindMany.mockResolvedValue([
            {
                id: 'plan-1',
                riskId: 'risk-1',
                strategy: 'MITIGATE',
                targetDate: IN_RANGE,
                ownerUserId: OWNER,
                risk: { title: 'Vendor concentration' },
            },
        ]);
        expect((await eventOfType('treatment-plan-target'))?.ownerUserId).toBe(OWNER);
    });

    it('a milestone with no owner column of its own inherits the plan owner', async () => {
        mockTreatmentMilestoneFindMany.mockResolvedValue([
            {
                id: 'ms-1',
                title: 'Sign DPA',
                dueDate: IN_RANGE,
                completedAt: null,
                sortOrder: 0,
                treatmentPlan: {
                    id: 'plan-1',
                    riskId: 'risk-1',
                    ownerUserId: OWNER,
                    risk: { title: 'Vendor concentration' },
                },
            },
        ]);
        expect((await eventOfType('treatment-milestone-due'))?.ownerUserId).toBe(OWNER);
    });

    it('a policy review carries its owner', async () => {
        mockPolicyFindMany.mockResolvedValue([
            {
                id: 'pol-1',
                title: 'Access Control Policy',
                nextReviewAt: IN_RANGE,
                status: 'PUBLISHED',
                ownerUserId: OWNER,
            },
        ]);
        expect((await eventOfType('policy-review'))?.ownerUserId).toBe(OWNER);
    });

    it('a finding routes to its assignee, never to the legacy free-text owner', async () => {
        mockFindingFindMany.mockResolvedValue([
            {
                id: 'find-1',
                title: 'Missing 2FA',
                dueDate: IN_RANGE,
                status: 'OPEN',
                assigneeUserId: OWNER,
            },
        ]);
        expect((await eventOfType('finding-due'))?.ownerUserId).toBe(OWNER);
    });

    it('a finding with only the legacy free-text owner reports NO owner', async () => {
        // `Finding.owner` holds a NAME. Publishing it as `ownerUserId` is worse
        // than publishing nothing: a name can never match the viewer, and in
        // the digest it resolves to no user and the item is dropped instead of
        // falling back to tenant admins.
        mockFindingFindMany.mockResolvedValue([
            {
                id: 'find-2',
                title: 'Legacy finding',
                dueDate: IN_RANGE,
                status: 'OPEN',
                owner: 'Alice Smith',
                assigneeUserId: null,
            },
        ]);
        expect((await eventOfType('finding-due'))?.ownerUserId).toBeUndefined();
    });
});

describe('control test deadlines vs implementation status', () => {
    const PAST = new Date('2026-05-15T00:00:00Z'); // inside [FROM, TO], before NOW

    it('an IMPLEMENTED control with a lapsed test is overdue, not done', async () => {
        mockControlFindMany.mockResolvedValue([
            {
                id: 'ctrl-1',
                name: 'Quarterly access review',
                nextDueAt: PAST,
                ownerUserId: OWNER,
            },
        ]);
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const res = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        const ev = res.events.find((e) => e.type === 'control-review');
        // `nextDueAt` is the next TEST due date; no ControlStatus satisfies it.
        // This used to short-circuit to 'done' before any date comparison,
        // while deadline-monitor emailed the same row as overdue.
        expect(ev?.status).toBe('overdue');
    });

    it('the calendar and the deadline monitor agree on which controls are eligible', async () => {
        const { CONTROL_TEST_ELIGIBILITY } = await import(
            '@/app-layer/domain/control-test-due'
        );
        mockControlFindMany.mockResolvedValue([]);
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        // Both surfaces spread the same shared fragment, so agreement is
        // structural rather than two literals that happen to match today.
        const where = mockControlFindMany.mock.calls[0][0].where;
        expect(where).toMatchObject(CONTROL_TEST_ELIGIBILITY);
    });

    it('no ControlStatus value can mark a test deadline satisfied', async () => {
        const { isControlTestSatisfied, isControlTestOutstanding } = await import(
            '@/app-layer/domain/control-test-due'
        );
        expect(isControlTestSatisfied()).toBe(false);
        // The obligation is a pure date question — which is what makes the two
        // surfaces agree once both ask it here.
        expect(isControlTestOutstanding(PAST, NOW)).toBe(true);
        expect(isControlTestOutstanding(new Date('2026-07-15T00:00:00Z'), NOW)).toBe(false);
        expect(isControlTestOutstanding(null, NOW)).toBe(false);
    });
});

// ─── Second-order correctness ────────────────────────────────────────
//
// Each of these is a place the calendar reported confidently and was wrong.

describe('per-source error isolation', () => {
    const IN_RANGE = new Date('2026-06-15T00:00:00Z');

    async function aggregate() {
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        return getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
    }

    it('one failing source does not blank the other sixteen', async () => {
        // A Prisma interactive-transaction timeout is the expected failure:
        // the 8s per-source budget REJECTS on breach.
        mockRiskFindMany.mockRejectedValue(
            Object.assign(new Error('Transaction already closed'), { code: 'P2028' }),
        );
        mockPolicyFindMany.mockResolvedValue([
            {
                id: 'pol-1',
                title: 'Access Control Policy',
                nextReviewAt: IN_RANGE,
                status: 'PUBLISHED',
                ownerUserId: OWNER,
            },
        ]);

        const res = await aggregate();

        // Before isolation existed, this rejected the whole Promise.all and
        // 500'd the calendar — seventeen domains for a fault in one.
        expect(res.events.some((e) => e.type === 'policy-review')).toBe(true);
        expect(res.failedSources).toContain('risk');
        // The failure is REPORTED, not swallowed: a missing domain must not
        // read as a domain with nothing due.
        expect(res.counts.partial).toBe(true);
    });

    it('names only the sources that actually failed', async () => {
        mockRiskFindMany.mockRejectedValue(new Error('boom'));
        const res = await aggregate();
        expect(res.failedSources).toEqual(['risk']);
        expect(res.omittedSources).not.toContain('risk'); // not a permission problem
    });

    it('throws when EVERY source fails rather than reporting an empty calendar', async () => {
        // An empty grid plus a notice reads as "nothing is due". On a deadline
        // product that is the most dangerous sentence this surface can say.
        const boom = () => Promise.reject(new Error('down'));
        for (const m of [
            mockEvidenceFindMany, mockPolicyFindMany, mockVendorFindMany,
            mockVendorDocFindMany, mockAuditCycleFindMany, mockControlFindMany,
            mockTestPlanFindMany, mockTaskFindMany, mockRiskFindMany,
            mockFindingFindMany, mockTreatmentMilestoneFindMany,
            mockTreatmentPlanFindMany, mockAccessReviewFindMany,
            mockTrainingFindMany, mockIncidentNotificationFindMany,
            mockControlExceptionFindMany, mockVendorAssessmentFindMany,
        ]) {
            m.mockImplementation(boom);
        }
        await expect(aggregate()).rejects.toThrow(/every source failed/);
    });
});

describe('one definition of "day"', () => {
    it('publishes the civil day statuses were judged against', async () => {
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        const res = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        // The client rings this day rather than deriving its own from the
        // browser clock — which is how an event ended up in one cell, ringed
        // in another, and coloured against a third.
        expect(res.todayYmd).toBe('2026-06-01');
    });

    it('classifies a deadline against the day the grid draws it in', async () => {
        const { getComplianceCalendarEvents } = await import(
            '@/app-layer/usecases/compliance-calendar'
        );
        // Stored at UTC midnight, which is how day-resolution deadlines land.
        // The grid buckets it by `date.slice(0,10)` = 2026-06-01 — the same
        // day as `now`. Same day is due_soon, never overdue.
        mockPolicyFindMany.mockResolvedValue([
            {
                id: 'pol-1',
                title: 'Same-day review',
                nextReviewAt: new Date('2026-06-01T00:00:00Z'),
                status: 'PUBLISHED',
                ownerUserId: OWNER,
            },
        ]);
        const res = await getComplianceCalendarEvents(makeCtx() as never, {
            from: FROM,
            to: TO,
            now: NOW,
        });
        const ev = res.events.find((e) => e.type === 'policy-review');
        expect(ev?.date.slice(0, 10)).toBe(res.todayYmd);
        expect(ev?.status).toBe('due_soon');
    });
});
