/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage — AccessReviewRepository (Epic G-4), previously 0% branches.
 *
 * The repository is a thin, static, db-param wrapper around Prisma: every
 * method takes an explicit `db: PrismaTx` (no runInTenantContext, no audit
 * emitter). So the unit test mocks `db` as an object of jest.fn() model
 * methods and asserts the WHERE / orderBy / take / data shape each method
 * constructs — exercising every option/filter branch and every early-return
 * guard (empty arrays, scope arms, includeDeleted, status, take, evidence-id
 * undefined-vs-null).
 */
import { AccessReviewRepository } from '@/app-layer/repositories/AccessReviewRepository';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function freshDb() {
    return {
        accessReview: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'ar1' }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        accessReviewDecision: {
            createMany: jest.fn().mockResolvedValue({ count: 3 }),
            findFirst: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockResolvedValue([]),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        tenantMembership: {
            findMany: jest.fn().mockResolvedValue([]),
        },
    };
}

let db: any;
beforeEach(() => {
    jest.clearAllMocks();
    db = freshDb();
});

describe('AccessReviewRepository.list', () => {
    it('default options: filters deletedAt:null, no status, no take', async () => {
        await AccessReviewRepository.list(db, ctx);
        const arg = (db.accessReview.findMany as jest.Mock).mock.calls[0][0];
        expect(arg.where.tenantId).toBe('tenant-1');
        // Branch: includeDeleted falsy → deletedAt:null spread present.
        expect(arg.where.deletedAt).toBeNull();
        // Branch: no status → no status key.
        expect(arg.where.status).toBeUndefined();
        // Branch: no take → no take key.
        expect(arg.take).toBeUndefined();
        expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('includeDeleted:true drops the deletedAt filter; status + take applied', async () => {
        await AccessReviewRepository.list(db, ctx, {
            includeDeleted: true,
            status: 'OPEN' as any,
            take: 25,
        });
        const arg = (db.accessReview.findMany as jest.Mock).mock.calls[0][0];
        // Branch: includeDeleted truthy → no deletedAt key.
        expect('deletedAt' in arg.where).toBe(false);
        // Branch: status present.
        expect(arg.where.status).toBe('OPEN');
        // Branch: take present.
        expect(arg.take).toBe(25);
    });
});

describe('AccessReviewRepository.getById', () => {
    it('queries by id + tenant + deletedAt:null with the detail include', async () => {
        await AccessReviewRepository.getById(db, ctx, 'ar1');
        const arg = (db.accessReview.findFirst as jest.Mock).mock.calls[0][0];
        expect(arg.where).toEqual({ id: 'ar1', tenantId: 'tenant-1', deletedAt: null });
        expect(arg.include).toBeDefined();
    });
});

describe('AccessReviewRepository.create', () => {
    it('applies nullish defaults when optional fields omitted', async () => {
        await AccessReviewRepository.create(db, ctx, {
            name: 'Q1 review',
            scope: 'ALL_USERS' as any,
            reviewerUserId: 'rev1',
        });
        const data = (db.accessReview.create as jest.Mock).mock.calls[0][0].data;
        // Branches: description/periodStartAt/periodEndAt/dueAt all ?? null.
        expect(data.description).toBeNull();
        expect(data.periodStartAt).toBeNull();
        expect(data.periodEndAt).toBeNull();
        expect(data.dueAt).toBeNull();
        expect(data.tenantId).toBe('tenant-1');
        expect(data.createdByUserId).toBe('user-1');
    });

    it('passes through provided optional fields', async () => {
        const start = new Date('2026-01-01');
        const end = new Date('2026-02-01');
        const due = new Date('2026-03-01');
        await AccessReviewRepository.create(db, ctx, {
            name: 'Q1 review',
            description: 'desc',
            scope: 'ADMIN_ONLY' as any,
            periodStartAt: start,
            periodEndAt: end,
            dueAt: due,
            reviewerUserId: 'rev1',
        });
        const data = (db.accessReview.create as jest.Mock).mock.calls[0][0].data;
        // Branches: each ?? left-hand side taken.
        expect(data.description).toBe('desc');
        expect(data.periodStartAt).toBe(start);
        expect(data.periodEndAt).toBe(end);
        expect(data.dueAt).toBe(due);
    });
});

describe('AccessReviewRepository.bulkCreateDecisions', () => {
    it('returns 0 and skips createMany on empty rows', async () => {
        // Branch: rows.length === 0 early return.
        const n = await AccessReviewRepository.bulkCreateDecisions(db, ctx, 'ar1', []);
        expect(n).toBe(0);
        expect(db.accessReviewDecision.createMany).not.toHaveBeenCalled();
    });

    it('maps rows to createMany data + returns inserted count', async () => {
        const rows = [
            {
                membershipId: 'm1',
                subjectUserId: 'u1',
                snapshotRole: 'ADMIN' as any,
                snapshotCustomRoleId: null,
                snapshotMembershipStatus: 'ACTIVE' as any,
            },
            {
                membershipId: null,
                subjectUserId: 'u2',
                snapshotRole: 'READER' as any,
                snapshotCustomRoleId: 'cr1',
                snapshotMembershipStatus: 'INVITED' as any,
            },
        ];
        const n = await AccessReviewRepository.bulkCreateDecisions(db, ctx, 'ar1', rows);
        expect(n).toBe(3);
        const arg = (db.accessReviewDecision.createMany as jest.Mock).mock.calls[0][0];
        expect(arg.skipDuplicates).toBe(true);
        expect(arg.data).toHaveLength(2);
        expect(arg.data[0]).toEqual({
            tenantId: 'tenant-1',
            accessReviewId: 'ar1',
            membershipId: 'm1',
            subjectUserId: 'u1',
            snapshotRole: 'ADMIN',
            snapshotCustomRoleId: null,
            snapshotMembershipStatus: 'ACTIVE',
        });
        expect(arg.data[1].membershipId).toBeNull();
        expect(arg.data[1].snapshotCustomRoleId).toBe('cr1');
    });
});

describe('AccessReviewRepository.getDecision', () => {
    it('queries by decisionId + tenant with accessReview include', async () => {
        await AccessReviewRepository.getDecision(db, ctx, 'dec1');
        const arg = (db.accessReviewDecision.findFirst as jest.Mock).mock.calls[0][0];
        expect(arg.where).toEqual({ id: 'dec1', tenantId: 'tenant-1' });
        expect(arg.include.accessReview).toBeDefined();
    });
});

describe('AccessReviewRepository.updateDecision', () => {
    it('applies nullish defaults for optional fields', async () => {
        const decidedAt = new Date();
        const n = await AccessReviewRepository.updateDecision(db, ctx, 'dec1', {
            decision: 'APPROVE' as any,
            decidedAt,
            decidedByUserId: 'rev1',
        });
        expect(n).toBe(1);
        const arg = (db.accessReviewDecision.updateMany as jest.Mock).mock.calls[0][0];
        expect(arg.where).toEqual({ id: 'dec1', tenantId: 'tenant-1' });
        // Branches: notes/modifiedToRole/modifiedToCustomRoleId ?? null.
        expect(arg.data.notes).toBeNull();
        expect(arg.data.modifiedToRole).toBeNull();
        expect(arg.data.modifiedToCustomRoleId).toBeNull();
        expect(arg.data.decidedAt).toBe(decidedAt);
    });

    it('passes through provided optional fields', async () => {
        await AccessReviewRepository.updateDecision(db, ctx, 'dec1', {
            decision: 'MODIFY' as any,
            decidedAt: new Date(),
            decidedByUserId: 'rev1',
            notes: 'note',
            modifiedToRole: 'EDITOR' as any,
            modifiedToCustomRoleId: 'cr9',
        });
        const arg = (db.accessReviewDecision.updateMany as jest.Mock).mock.calls[0][0];
        // Branches: each ?? left-hand side taken.
        expect(arg.data.notes).toBe('note');
        expect(arg.data.modifiedToRole).toBe('EDITOR');
        expect(arg.data.modifiedToCustomRoleId).toBe('cr9');
    });
});

describe('AccessReviewRepository.resetDecision', () => {
    it('scopes by executedAt:null and nulls every verdict field', async () => {
        (db.accessReviewDecision.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        const n = await AccessReviewRepository.resetDecision(db, ctx, 'dec1');
        // Branch: count===0 surfaced verbatim to caller.
        expect(n).toBe(0);
        const arg = (db.accessReviewDecision.updateMany as jest.Mock).mock.calls[0][0];
        expect(arg.where).toEqual({ id: 'dec1', tenantId: 'tenant-1', executedAt: null });
        expect(arg.data).toEqual({
            decision: null,
            decidedAt: null,
            decidedByUserId: null,
            notes: null,
            modifiedToRole: null,
            modifiedToCustomRoleId: null,
        });
    });
});

describe('AccessReviewRepository.setReviewStatus', () => {
    it('updates status scoped to tenant + not-deleted', async () => {
        const n = await AccessReviewRepository.setReviewStatus(db, ctx, 'ar1', 'IN_REVIEW' as any);
        expect(n).toBe(1);
        const arg = (db.accessReview.updateMany as jest.Mock).mock.calls[0][0];
        expect(arg.where).toEqual({ id: 'ar1', tenantId: 'tenant-1', deletedAt: null });
        expect(arg.data).toEqual({ status: 'IN_REVIEW' });
    });
});

describe('AccessReviewRepository.closeCampaign', () => {
    it('omits evidenceFileRecordId when undefined', async () => {
        const closedAt = new Date();
        await AccessReviewRepository.closeCampaign(db, ctx, 'ar1', closedAt);
        const arg = (db.accessReview.updateMany as jest.Mock).mock.calls[0][0];
        // Branch: evidenceFileRecordId === undefined → key absent.
        expect('evidenceFileRecordId' in arg.data).toBe(false);
        expect(arg.data.status).toBe('CLOSED');
        expect(arg.data.closedAt).toBe(closedAt);
        expect(arg.data.closedByUserId).toBe('user-1');
    });

    it('includes evidenceFileRecordId when provided (incl. explicit null)', async () => {
        await AccessReviewRepository.closeCampaign(db, ctx, 'ar1', new Date(), 'file1');
        let arg = (db.accessReview.updateMany as jest.Mock).mock.calls[0][0];
        // Branch: defined non-null → key present.
        expect(arg.data.evidenceFileRecordId).toBe('file1');

        (db.accessReview.updateMany as jest.Mock).mockClear();
        await AccessReviewRepository.closeCampaign(db, ctx, 'ar1', new Date(), null);
        arg = (db.accessReview.updateMany as jest.Mock).mock.calls[0][0];
        // Branch: explicit null is !== undefined → key present, value null.
        expect('evidenceFileRecordId' in arg.data).toBe(true);
        expect(arg.data.evidenceFileRecordId).toBeNull();
    });
});

describe('AccessReviewRepository.markDecisionExecuted', () => {
    it('sets executedAt + executedByUserId scoped to tenant', async () => {
        const executedAt = new Date();
        const n = await AccessReviewRepository.markDecisionExecuted(db, ctx, 'dec1', executedAt);
        expect(n).toBe(1);
        const arg = (db.accessReviewDecision.updateMany as jest.Mock).mock.calls[0][0];
        expect(arg.where).toEqual({ id: 'dec1', tenantId: 'tenant-1' });
        expect(arg.data).toEqual({ executedAt, executedByUserId: 'user-1' });
    });
});

describe('AccessReviewRepository.getDecisionsForExecution', () => {
    it('queries decisions for the campaign scoped to tenant', async () => {
        await AccessReviewRepository.getDecisionsForExecution(db, ctx, 'ar1');
        const arg = (db.accessReviewDecision.findMany as jest.Mock).mock.calls[0][0];
        expect(arg.where).toEqual({ accessReviewId: 'ar1', tenantId: 'tenant-1' });
        expect(arg.select.membership).toBeDefined();
        expect(arg.select.subjectUser).toBeDefined();
    });
});

describe('AccessReviewRepository.resolveMembershipsForScope', () => {
    it('ALL_USERS scope: no role / id narrowing, only status filter', async () => {
        await AccessReviewRepository.resolveMembershipsForScope(db, ctx, 'ALL_USERS' as any);
        const arg = (db.tenantMembership.findMany as jest.Mock).mock.calls[0][0];
        // Branch: neither ADMIN_ONLY nor CUSTOM.
        expect(arg.where.tenantId).toBe('tenant-1');
        expect(arg.where.status).toEqual({ in: ['ACTIVE', 'INVITED'] });
        expect(arg.where.role).toBeUndefined();
        expect(arg.where.id).toBeUndefined();
    });

    it('ADMIN_ONLY scope: narrows role to OWNER/ADMIN', async () => {
        await AccessReviewRepository.resolveMembershipsForScope(db, ctx, 'ADMIN_ONLY' as any);
        const arg = (db.tenantMembership.findMany as jest.Mock).mock.calls[0][0];
        // Branch: ADMIN_ONLY arm.
        expect(arg.where.role).toEqual({ in: ['OWNER', 'ADMIN'] });
        expect(arg.where.id).toBeUndefined();
    });

    it('CUSTOM scope with ids: narrows id', async () => {
        await AccessReviewRepository.resolveMembershipsForScope(
            db,
            ctx,
            'CUSTOM' as any,
            ['m1', 'm2'],
        );
        const arg = (db.tenantMembership.findMany as jest.Mock).mock.calls[0][0];
        // Branch: CUSTOM arm with provided ids.
        expect(arg.where.id).toEqual({ in: ['m1', 'm2'] });
    });

    it('CUSTOM scope without ids: defaults to empty in[]', async () => {
        await AccessReviewRepository.resolveMembershipsForScope(db, ctx, 'CUSTOM' as any);
        const arg = (db.tenantMembership.findMany as jest.Mock).mock.calls[0][0];
        // Branch: CUSTOM arm, customMembershipIds undefined → ?? [] default.
        expect(arg.where.id).toEqual({ in: [] });
    });
});
