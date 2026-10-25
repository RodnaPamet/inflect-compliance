/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that stand
 * in for a Prisma client; the file-level disable is this repo's standard for
 * the shape. */
/**
 * Three things a member access-review campaign could not do (#4130):
 *
 *   1. Report how far it had got. The register's Progress column read
 *      `decidedCount`, which nothing sent, so every campaign — closed ones
 *      included — showed 0 of N. `listAccessReviews` now sends it.
 *   2. Change hands. The overdue email told admins to reassign a campaign and
 *      no verb existed. `updateAccessReviewSettings` changes the reviewer and
 *      the due date of an open campaign, and nothing else.
 *   3. Recover its evidence. The close commits before it renders the PDF, so a
 *      failed PDF was permanent. `regenerateAccessReviewEvidence` rebuilds it
 *      from the stored decisions with the close's own builder — and the PDF,
 *      at close and again, now carries each reviewer's justification.
 */
jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockWrite = jest.fn();
jest.mock('@/lib/storage', () => ({
    getStorageProvider: jest.fn(() => ({ name: 'local', write: mockWrite })),
    buildTenantObjectKey: jest.fn((t: string, d: string, f: string) => `${t}/${d}/${f}`),
}));
const mockGeneratePdf = jest.fn();
jest.mock('@/app-layer/reports/pdf/accessReview', () => ({
    generateAccessReviewPdf: (input: unknown) => mockGeneratePdf(input),
}));
jest.mock('@/app-layer/reports/pdf/collect-buffer', () => ({
    collectPdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 test')),
}));

import { ZodError } from 'zod';

import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import {
    closeAccessReview,
    listAccessReviews,
    regenerateAccessReviewEvidence,
    UNRECORDED_OUTCOME,
    updateAccessReviewSettings,
} from '@/app-layer/usecases/access-review';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;
const owner = () => makeRequestContext('OWNER', { tenantId: 'tenant-1', userId: 'owner-1' });
const admin = () => makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'admin-1' });
const editor = () => makeRequestContext('EDITOR', { tenantId: 'tenant-1', userId: 'editor-1' });

const audit = (action: string) => (logEvent as jest.Mock).mock.calls.find((c) => c[2].action === action)?.[2];
const auditActions = () => (logEvent as jest.Mock).mock.calls.map((c) => c[2].action);

function withDb(db: unknown) {
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
}

beforeEach(() => {
    jest.clearAllMocks();
    mockWrite.mockResolvedValue({ sizeBytes: 2048, sha256: 'ab'.repeat(32) });
    mockGeneratePdf.mockReturnValue({});
});

// ─── 1. The register's Progress column ─────────────────────────────

describe('listAccessReviews — sends how many subjects are decided', () => {
    it('counts decided rows in BOTH subject tables per campaign; a campaign with none reads 0', async () => {
        const db = {
            accessReview: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 'ar-member', _count: { decisions: 3, connectedDecisions: 0 } },
                    { id: 'ar-connected', _count: { decisions: 0, connectedDecisions: 2 } },
                    { id: 'ar-untouched', _count: { decisions: 4, connectedDecisions: 0 } },
                ]),
            },
            accessReviewDecision: {
                groupBy: jest.fn().mockResolvedValue([{ accessReviewId: 'ar-member', _count: { _all: 3 } }]),
            },
            accessReviewConnectedDecision: {
                groupBy: jest.fn().mockResolvedValue([{ accessReviewId: 'ar-connected', _count: { _all: 1 } }]),
            },
        };
        withDb(db);
        const rows = await listAccessReviews(editor());
        expect(rows.map((r) => [r.id, r.decidedCount])).toEqual([
            ['ar-member', 3],
            ['ar-connected', 1],
            ['ar-untouched', 0],
        ]);
        // Decided means a verdict is recorded, tenant-scoped, over exactly the listed campaigns.
        for (const groupBy of [db.accessReviewDecision.groupBy, db.accessReviewConnectedDecision.groupBy]) {
            expect(groupBy.mock.calls[0][0].where).toEqual({
                tenantId: 'tenant-1',
                accessReviewId: { in: ['ar-member', 'ar-connected', 'ar-untouched'] },
                decision: { not: null },
            });
        }
    });

    it('an empty register makes no count query', async () => {
        const db = {
            accessReview: { findMany: jest.fn().mockResolvedValue([]) },
            accessReviewDecision: { groupBy: jest.fn() },
            accessReviewConnectedDecision: { groupBy: jest.fn() },
        };
        withDb(db);
        await expect(listAccessReviews(editor())).resolves.toEqual([]);
        expect(db.accessReviewDecision.groupBy).not.toHaveBeenCalled();
    });
});

// ─── 2. Reviewer and due date ──────────────────────────────────────

function settingsDb(review: Record<string, unknown> | null, opts: { member?: boolean; updated?: number } = {}) {
    const db = {
        accessReview: {
            findFirst: jest.fn().mockResolvedValue(
                review === null
                    ? null
                    : {
                          id: 'ar-1',
                          name: 'Q4',
                          scope: 'ALL_USERS',
                          status: 'IN_REVIEW',
                          reviewerUserId: 'rev-old',
                          dueAt: new Date('2026-10-01T00:00:00.000Z'),
                          ...review,
                      },
            ),
            updateMany: jest.fn().mockResolvedValue({ count: opts.updated ?? 1 }),
        },
        tenantMembership: {
            findFirst: jest.fn().mockResolvedValue(opts.member === false ? null : { id: 'm-new' }),
        },
    };
    withDb(db);
    return db;
}

describe('updateAccessReviewSettings — the reviewer and due date of an open campaign, and nothing else', () => {
    it('changes both, writes only them, conditional on the campaign not being CLOSED, and audits before/after', async () => {
        const db = settingsDb({});
        const result = await updateAccessReviewSettings(admin(), 'ar-1', {
            reviewerUserId: 'rev-new',
            dueAt: '2026-11-15T00:00:00.000Z',
        });
        expect(result).toMatchObject({ reviewerUserId: 'rev-new', changed: ['dueAt', 'reviewerUserId'] });
        expect(db.tenantMembership.findFirst.mock.calls[0][0].where).toEqual({
            tenantId: 'tenant-1',
            userId: 'rev-new',
            status: 'ACTIVE',
        });
        const write = db.accessReview.updateMany.mock.calls[0][0];
        expect(write.where).toEqual({ id: 'ar-1', tenantId: 'tenant-1', deletedAt: null, status: { not: 'CLOSED' } });
        expect(Object.keys(write.data).sort()).toEqual(['dueAt', 'reviewerUserId']);
        expect(write.data.dueAt.toISOString()).toBe('2026-11-15T00:00:00.000Z');
        expect(audit('ACCESS_REVIEW_UPDATED')).toMatchObject({
            entityType: 'AccessReview',
            entityId: 'ar-1',
            detailsJson: expect.objectContaining({
                before: { reviewerUserId: 'rev-old', dueAt: '2026-10-01T00:00:00.000Z' },
                after: { reviewerUserId: 'rev-new', dueAt: '2026-11-15T00:00:00.000Z' },
            }),
        });
    });

    it('clears the due date with null, without touching the reviewer', async () => {
        const db = settingsDb({});
        await updateAccessReviewSettings(owner(), 'ar-1', { dueAt: null });
        expect(db.accessReview.updateMany.mock.calls[0][0].data).toEqual({ dueAt: null });
        expect(db.tenantMembership.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a reviewer who is not an ACTIVE member of the tenant, and writes nothing', async () => {
        const db = settingsDb({}, { member: false });
        await expect(updateAccessReviewSettings(admin(), 'ar-1', { reviewerUserId: 'stranger' })).rejects.toThrow(
            /REVIEWER_NOT_A_MEMBER/,
        );
        expect(db.accessReview.updateMany).not.toHaveBeenCalled();
        expect(auditActions()).toEqual([]);
    });

    it('refuses a CLOSED campaign, and an agent recertification by name', async () => {
        let db = settingsDb({ status: 'CLOSED' });
        await expect(updateAccessReviewSettings(admin(), 'ar-1', { dueAt: null })).rejects.toThrow(/closed/);
        expect(db.accessReview.updateMany).not.toHaveBeenCalled();

        db = settingsDb({ scope: 'AGENT' });
        await expect(updateAccessReviewSettings(admin(), 'ar-1', { dueAt: null })).rejects.toMatchObject({
            status: 409,
            details: { reason: 'CAMPAIGN_SETTINGS_FIXED_FOR_SCOPE' },
        });
        expect(db.accessReview.updateMany).not.toHaveBeenCalled();
    });

    it('a connected campaign can be reassigned too: the reviewer field is the same column', async () => {
        const db = settingsDb({ scope: 'CONNECTED_APP' });
        await updateAccessReviewSettings(admin(), 'ar-1', { reviewerUserId: 'rev-new' });
        expect(db.accessReview.updateMany).toHaveBeenCalledTimes(1);
    });

    it('a close that lands between the read and the write wins: 409, no audit row', async () => {
        settingsDb({}, { updated: 0 });
        await expect(updateAccessReviewSettings(admin(), 'ar-1', { dueAt: null })).rejects.toMatchObject({ status: 409 });
        expect(auditActions()).toEqual([]);
    });

    it('a request that matches the campaign changes nothing and writes no audit row', async () => {
        const db = settingsDb({});
        const result = await updateAccessReviewSettings(admin(), 'ar-1', {
            reviewerUserId: 'rev-old',
            dueAt: '2026-10-01T00:00:00.000Z',
        });
        expect(result.changed).toEqual([]);
        expect(db.accessReview.updateMany).not.toHaveBeenCalled();
        expect(auditActions()).toEqual([]);
    });

    it('the body is strict: a name, scope or period is refused, and an empty body is refused', async () => {
        settingsDb({});
        for (const body of [{ name: 'Renamed' }, { scope: 'ADMIN_ONLY' }, { periodStartAt: '2026-01-01T00:00:00.000Z' }, {}]) {
            await expect(updateAccessReviewSettings(admin(), 'ar-1', body)).rejects.toBeInstanceOf(ZodError);
        }
    });

    it('is OWNER/ADMIN only', async () => {
        const db = settingsDb({});
        await expect(updateAccessReviewSettings(editor(), 'ar-1', { dueAt: null })).rejects.toMatchObject({ status: 403 });
        expect(db.accessReview.findFirst).not.toHaveBeenCalled();
    });
});

// ─── 3. The evidence PDF ───────────────────────────────────────────

/** A decision as `getDecisionsForExecution` returns it. */
function storedDecision(id: string, decision: 'CONFIRM' | 'REVOKE' | 'MODIFY', notes: string | null) {
    return {
        id,
        membershipId: `m-${id}`,
        subjectUserId: `u-${id}`,
        snapshotRole: 'EDITOR',
        snapshotMembershipStatus: 'ACTIVE',
        decision,
        modifiedToRole: decision === 'MODIFY' ? 'READER' : null,
        modifiedToCustomRoleId: null,
        executedAt: new Date('2026-10-20T10:00:00.000Z'),
        decidedAt: new Date('2026-10-19T09:00:00.000Z'),
        decidedByUserId: 'reviewer-1',
        notes,
        membership: { id: `m-${id}`, userId: `u-${id}`, role: 'EDITOR', status: 'ACTIVE', customRoleId: null },
        subjectUser: { id: `u-${id}`, email: `${id}@x.test`, name: null },
    };
}

const CLOSED_AT = new Date('2026-10-20T10:00:00.000Z');

function regenerateDb(review: Record<string, unknown>, decisions: unknown[], executed: unknown[]) {
    const db = {
        accessReview: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'ar-1',
                tenantId: 'tenant-1',
                name: 'Q4 review',
                description: null,
                scope: 'ALL_USERS',
                status: 'CLOSED',
                deletedAt: null,
                periodStartAt: null,
                periodEndAt: null,
                closedAt: CLOSED_AT,
                evidenceFileRecordId: null,
                reviewer: { email: 'reviewer@x.test' },
                createdBy: { email: 'creator@x.test' },
                closedBy: { email: 'closer@x.test' },
                ...review,
            }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        accessReviewDecision: { findMany: jest.fn().mockResolvedValue(decisions) },
        auditLog: { findMany: jest.fn().mockResolvedValue(executed) },
        tenant: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme' }) },
        fileRecord: { create: jest.fn().mockResolvedValue({ id: 'file-new' }) },
    };
    withDb(db);
    return db;
}

const executedRow = (id: string, outcome: string) => ({
    entityId: id,
    detailsJson: { category: 'access', after: { outcome } },
});

describe('regenerateAccessReviewEvidence — the PDF a failed close never produced', () => {
    it('rebuilds it from the stored decisions: the recorded outcomes, the closer and close time on the campaign, the justifications', async () => {
        const db = regenerateDb(
            {},
            [storedDecision('d-1', 'CONFIRM', 'Still in the team'), storedDecision('d-2', 'REVOKE', null)],
            [executedRow('d-1', 'NO_CHANGE'), executedRow('d-2', 'SKIPPED_LAST_OWNER')],
        );
        // Regenerated by somebody other than the closer.
        const result = await regenerateAccessReviewEvidence(owner(), 'ar-1');
        expect(result).toEqual({ accessReviewId: 'ar-1', evidenceFileRecordId: 'file-new' });

        const input = mockGeneratePdf.mock.calls[0][0];
        expect(input).toMatchObject({
            tenantName: 'Acme',
            campaignName: 'Q4 review',
            closedByEmail: 'closer@x.test',
            closedAtIso: CLOSED_AT.toISOString(),
            watermark: 'FINAL',
        });
        expect(input.decisions.map((d: any) => [d.subjectUserEmail, d.executionOutcome, d.notes, d.decidedAtIso])).toEqual([
            ['d-1@x.test', 'NO_CHANGE', 'Still in the team', '2026-10-19T09:00:00.000Z'],
            ['d-2@x.test', 'SKIPPED_LAST_OWNER', null, '2026-10-19T09:00:00.000Z'],
        ]);

        // The outcomes come from the close's own audit rows for exactly these decisions.
        expect(db.auditLog.findMany.mock.calls[0][0].where).toEqual({
            tenantId: 'tenant-1',
            action: 'ACCESS_REVIEW_DECISION_EXECUTED',
            entity: 'AccessReviewDecision',
            entityId: { in: ['d-1', 'd-2'] },
        });

        // Attached ONLY where the campaign is CLOSED and has none — and the
        // closer and close time are not rewritten by the regenerator.
        const attach = db.accessReview.updateMany.mock.calls[0][0];
        expect(attach.where).toMatchObject({ id: 'ar-1', status: 'CLOSED', evidenceFileRecordId: null });
        expect(attach.data).toEqual({ evidenceFileRecordId: 'file-new' });

        expect(audit('ACCESS_REVIEW_EVIDENCE_REGENERATED')).toMatchObject({
            entityType: 'AccessReview',
            entityId: 'ar-1',
            detailsJson: expect.objectContaining({ after: expect.objectContaining({ fileRecordId: 'file-new' }) }),
        });
    });

    it('a row the close recorded no outcome for is printed as unrecorded, never guessed as EXECUTED', async () => {
        regenerateDb({}, [storedDecision('d-1', 'REVOKE', null)], []);
        await regenerateAccessReviewEvidence(admin(), 'ar-1');
        expect(mockGeneratePdf.mock.calls[0][0].decisions[0].executionOutcome).toBe(UNRECORDED_OUTCOME);
    });

    it.each([
        ['a campaign that is not closed', { status: 'IN_REVIEW', closedAt: null }, /closed campaign/],
        ['a campaign that already has its PDF', { evidenceFileRecordId: 'file-old' }, /already has its evidence/],
        ['a connected campaign', { scope: 'CONNECTED_APP' }, /member flow/],
    ] as const)('refuses %s, and writes nothing', async (_label, review, message) => {
        const db = regenerateDb(review, [storedDecision('d-1', 'CONFIRM', null)], []);
        await expect(regenerateAccessReviewEvidence(admin(), 'ar-1')).rejects.toThrow(message);
        expect(mockWrite).not.toHaveBeenCalled();
        expect(db.fileRecord.create).not.toHaveBeenCalled();
    });

    it('zero is never complete: a campaign with no subjects gets no evidence', async () => {
        regenerateDb({}, [], []);
        await expect(regenerateAccessReviewEvidence(admin(), 'ar-1')).rejects.toThrow(/no subjects/);
        expect(mockWrite).not.toHaveBeenCalled();
    });

    it('two racing regenerations attach one PDF: the loser is refused and its FileRecord rolls back', async () => {
        const db = regenerateDb({}, [storedDecision('d-1', 'CONFIRM', null)], [executedRow('d-1', 'NO_CHANGE')]);
        db.accessReview.updateMany.mockResolvedValue({ count: 0 });
        await expect(regenerateAccessReviewEvidence(admin(), 'ar-1')).rejects.toMatchObject({ status: 409 });
        expect(auditActions()).toEqual([]);
    });

    it('a failure is reported to the caller, not swallowed', async () => {
        regenerateDb({}, [storedDecision('d-1', 'CONFIRM', null)], []);
        mockWrite.mockRejectedValue(new Error('storage down'));
        await expect(regenerateAccessReviewEvidence(admin(), 'ar-1')).rejects.toThrow('storage down');
    });

    it('is OWNER/ADMIN only', async () => {
        const db = regenerateDb({}, [storedDecision('d-1', 'CONFIRM', null)], []);
        await expect(regenerateAccessReviewEvidence(editor(), 'ar-1')).rejects.toMatchObject({ status: 403 });
        expect(db.accessReview.findFirst).not.toHaveBeenCalled();
    });
});

describe('closeAccessReview — the evidence PDF carries the justifications', () => {
    it('passes each decision’s notes and decided-at to the PDF, and attaches it conditionally', async () => {
        const decisions = [storedDecision('d-1', 'CONFIRM', 'Needs it for payroll'), storedDecision('d-2', 'REVOKE', 'Left in June')];
        const db = {
            accessReview: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'ar-1',
                    tenantId: 'tenant-1',
                    name: 'Q4 review',
                    description: null,
                    scope: 'ALL_USERS',
                    status: 'IN_REVIEW',
                    deletedAt: null,
                    periodStartAt: null,
                    periodEndAt: null,
                    reviewer: { email: 'reviewer@x.test' },
                    createdBy: { email: 'creator@x.test' },
                }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            accessReviewDecision: {
                findMany: jest.fn().mockResolvedValue(decisions),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            tenantMembership: {
                findMany: jest.fn().mockResolvedValue([{ id: 'm-owner', userId: 'owner-1' }]),
                update: jest.fn().mockResolvedValue({}),
            },
            tenant: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme' }) },
            user: { findUnique: jest.fn().mockResolvedValue({ email: 'closer@x.test' }) },
            fileRecord: { create: jest.fn().mockResolvedValue({ id: 'file-1' }) },
        };
        withDb(db);
        const result = await closeAccessReview(admin(), 'ar-1');
        expect(result.evidenceFileRecordId).toBe('file-1');
        const input = mockGeneratePdf.mock.calls[0][0];
        expect(input.decisions.map((d: any) => [d.subjectUserEmail, d.notes, d.executionOutcome])).toEqual([
            ['d-1@x.test', 'Needs it for payroll', 'NO_CHANGE'],
            ['d-2@x.test', 'Left in June', 'EXECUTED'],
        ]);
        expect(input.decisions[0].decidedAtIso).toBe('2026-10-19T09:00:00.000Z');
        const attach = db.accessReview.updateMany.mock.calls.at(-1)![0];
        expect(attach.where).toMatchObject({ status: 'CLOSED', evidenceFileRecordId: null });
        expect(auditActions()).toContain('ACCESS_REVIEW_EVIDENCE_GENERATED');
    });
});
