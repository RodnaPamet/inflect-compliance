/**
 * PR-7 — CONNECTED_APP access reviews: snapshot connected accounts, submit
 * decisions, and close (REVOKE → remediation task). The mature member flow is
 * untouched; this exercises the parallel connected module.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/app-layer/repositories/AccessReviewRepository', () => ({
    AccessReviewRepository: {
        create: jest.fn(async () => ({ id: 'ar-1', name: 'Q3 connected' })),
        closeCampaign: jest.fn(async () => 1),
    },
}));

import { createConnectedAccessReview, submitConnectedDecision, closeConnectedAccessReview } from '@/app-layer/usecases/access-review-connected';
import { makeRequestContext } from '../helpers/make-context';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const mockDb = {
    connectedIdentityAccount: { findMany: jest.fn() },
    accessReviewConnectedDecision: { createMany: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    accessReview: { findFirst: jest.fn(), updateMany: jest.fn() },
    task: { create: jest.fn() },
    // Step 5a — HR context is READ from IdentityAccountLink (never written),
    // and the close path resolves the closing user's email for the PDF.
    identityAccountLink: { findMany: jest.fn() },
    user: { findUnique: jest.fn() },
    fileRecord: { create: jest.fn() },
};

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.connectedIdentityAccount.findMany.mockResolvedValue([
        { id: 'acc-1', provider: 'okta', email: 'a@x.com', displayName: 'A', isAdmin: true, mfaEnrolled: false, groupsJson: [], connectionId: 'conn-1', externalUserId: 'ext-a' },
        { id: 'acc-2', provider: 'okta', email: 'b@x.com', displayName: 'B', isAdmin: false, mfaEnrolled: true, groupsJson: [], connectionId: 'conn-1', externalUserId: 'ext-b' },
    ]);
    mockDb.accessReviewConnectedDecision.createMany.mockResolvedValue({ count: 2 });
    mockDb.identityAccountLink.findMany.mockResolvedValue([]);
    mockDb.user.findUnique.mockResolvedValue({ email: 'closer@x.com' });
    mockDb.accessReview.findFirst.mockResolvedValue({
        id: 'ar-1', name: 'Q3 connected', description: null, scope: 'CONNECTED_APP',
        periodStartAt: null, periodEndAt: null, status: 'OPEN', deletedAt: null,
        snapshotTruncated: false,
        reviewer: { email: 'rev@x.com' },
        createdBy: { email: 'creator@x.com' },
        tenant: { name: 'Acme' },
    });
    mockDb.task.create.mockResolvedValue({ id: 'task-1' });
    mockDb.accessReviewConnectedDecision.updateMany.mockResolvedValue({ count: 1 });
    // H4 — submitConnectedDecision loads the decision + its campaign for the
    // reviewer gate. Default: an open campaign whose reviewer is 'u-rev'.
    mockDb.accessReviewConnectedDecision.findFirst.mockResolvedValue({ id: 'dec-1', decision: null, accessReview: { reviewerUserId: 'u-rev', status: 'OPEN', deletedAt: null } });
    // H4 — the connected close claims the campaign atomically via updateMany.
    mockDb.accessReview.updateMany.mockResolvedValue({ count: 1 });
});

describe('createConnectedAccessReview', () => {
    it('snapshots active connected accounts into decision rows', async () => {
        const ctx = makeRequestContext('ADMIN');
        const r = await createConnectedAccessReview(ctx, { name: 'Q3 connected', reviewerUserId: 'u-rev' });
        expect(r.snapshotCount).toBe(2);
        const rows = mockDb.accessReviewConnectedDecision.createMany.mock.calls[0][0].data;
        // Step 5a — the reference is the account's OWN grain
        // (connectionId:externalUserId), not provider:email, which collided
        // across two connections of one provider and silently dropped a
        // subject through `skipDuplicates`.
        expect(rows[0].subjectRef).toBe('conn-1:ext-a');
        expect(rows[0].snapshotJson).toMatchObject({ provider: 'okta', isAdmin: true });
    });

    it('rejects when there are no active connected accounts', async () => {
        mockDb.connectedIdentityAccount.findMany.mockResolvedValue([]);
        const ctx = makeRequestContext('ADMIN');
        await expect(createConnectedAccessReview(ctx, { name: 'x', reviewerUserId: 'u' })).rejects.toThrow(/zero subjects|No active/i);
    });

    it('scopes the account query to one directory when a provider is given (Entra ID / AD)', async () => {
        const ctx = makeRequestContext('ADMIN');
        await createConnectedAccessReview(ctx, { name: 'Azure review', reviewerUserId: 'u-rev', provider: 'entra-id' });
        const where = mockDb.connectedIdentityAccount.findMany.mock.calls[0][0].where;
        // A specific provider filters to that directory only (not the `in` list).
        expect(where.provider).toBe('entra-id');

        await createConnectedAccessReview(ctx, { name: 'AD review', reviewerUserId: 'u-rev', provider: 'active-directory' });
        expect(mockDb.connectedIdentityAccount.findMany.mock.calls[1][0].where.provider).toBe('active-directory');
    });

    it('reviews every synced directory when no provider is given', async () => {
        const ctx = makeRequestContext('ADMIN');
        await createConnectedAccessReview(ctx, { name: 'All dirs', reviewerUserId: 'u-rev' });
        const where = mockDb.connectedIdentityAccount.findMany.mock.calls[0][0].where;
        // No provider → the `in` allowlist of every identity provider.
        expect(where.provider.in).toEqual(expect.arrayContaining(['okta', 'google-workspace', 'entra-id', 'active-directory']));
    });

    it('forbids a non-admin', async () => {
        const ctx = makeRequestContext('READER');
        await expect(createConnectedAccessReview(ctx, { name: 'x', reviewerUserId: 'u' })).rejects.toThrow();
    });
});

describe('submitConnectedDecision', () => {
    it('records a verdict on a pending decision', async () => {
        mockDb.accessReviewConnectedDecision.updateMany.mockResolvedValueOnce({ count: 1 });
        const ctx = makeRequestContext('ADMIN');
        const r = await submitConnectedDecision(ctx, 'dec-1', { decision: 'REVOKE', notes: 'left company' }, NOW);
        expect(r.decision).toBe('REVOKE');
        const where = mockDb.accessReviewConnectedDecision.updateMany.mock.calls[0][0].where;
        expect(where).toMatchObject({ id: 'dec-1', decision: null });
    });

    it('rejects a re-decision (already decided)', async () => {
        mockDb.accessReviewConnectedDecision.updateMany.mockResolvedValueOnce({ count: 0 });
        const ctx = makeRequestContext('ADMIN');
        await expect(submitConnectedDecision(ctx, 'dec-1', { decision: 'CONFIRM' }, NOW)).rejects.toThrow(/already decided|not found/i);
    });

    it('H4 — the assigned reviewer may decide', async () => {
        const ctx = makeRequestContext('EDITOR', { userId: 'u-rev' }); // matches reviewerUserId
        const r = await submitConnectedDecision(ctx, 'dec-1', { decision: 'CONFIRM' }, NOW);
        expect(r.decision).toBe('CONFIRM');
    });

    it('H4 — a read-only NON-reviewer, non-admin member is FORBIDDEN (was assertCanRead only)', async () => {
        const ctx = makeRequestContext('READER', { userId: 'someone-else' });
        await expect(submitConnectedDecision(ctx, 'dec-1', { decision: 'REVOKE' }, NOW)).rejects.toThrow(/assigned reviewer|admin/i);
        expect(mockDb.accessReviewConnectedDecision.updateMany).not.toHaveBeenCalled();
    });

    it('H4 — rejects a decision on a CLOSED campaign', async () => {
        mockDb.accessReviewConnectedDecision.findFirst.mockResolvedValueOnce({ id: 'dec-1', decision: null, accessReview: { reviewerUserId: 'u-rev', status: 'CLOSED', deletedAt: null } });
        const ctx = makeRequestContext('ADMIN');
        await expect(submitConnectedDecision(ctx, 'dec-1', { decision: 'CONFIRM' }, NOW)).rejects.toThrow(/closed/i);
    });
});

describe('closeConnectedAccessReview', () => {
    it('emits a remediation task per REVOKE/MODIFY and closes', async () => {
        mockDb.accessReviewConnectedDecision.findMany.mockResolvedValue([
            { id: 'd1', subjectRef: 'okta:a@x.com', decision: 'REVOKE' },
            { id: 'd2', subjectRef: 'okta:b@x.com', decision: 'CONFIRM' },
            { id: 'd3', subjectRef: 'okta:c@x.com', decision: 'MODIFY' },
        ]);
        const ctx = makeRequestContext('ADMIN');
        const r = await closeConnectedAccessReview(ctx, 'ar-1', NOW);
        expect(r.executed).toBe(3);
        expect(r.remediationTasks).toBe(2); // REVOKE + MODIFY, not CONFIRM
        expect(mockDb.task.create).toHaveBeenCalledTimes(2);
    });

    it('H4 — a concurrent close that lost the conditional update creates NO tasks (TOCTOU)', async () => {
        mockDb.accessReviewConnectedDecision.findMany.mockResolvedValue([
            { id: 'd1', subjectRef: 'okta:a@x.com', decision: 'REVOKE' },
        ]);
        // The conditional close-claim matched 0 rows — another close already won.
        mockDb.accessReview.updateMany.mockResolvedValueOnce({ count: 0 });
        const ctx = makeRequestContext('ADMIN');
        const r = await closeConnectedAccessReview(ctx, 'ar-1', NOW);
        expect(r.remediationTasks).toBe(0);
        expect(mockDb.task.create).not.toHaveBeenCalled(); // no double remediation
    });

    it('refuses to close with pending decisions', async () => {
        mockDb.accessReviewConnectedDecision.findMany.mockResolvedValue([{ id: 'd1', subjectRef: 'x', decision: null }]);
        const ctx = makeRequestContext('ADMIN');
        await expect(closeConnectedAccessReview(ctx, 'ar-1', NOW)).rejects.toThrow(/pending/i);
        expect(mockDb.task.create).not.toHaveBeenCalled();
    });
});
