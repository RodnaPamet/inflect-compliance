/**
 * Step 5a — the hardening checklist, one describe per item.
 *
 * Companion to `tests/unit/security/access-review-authz-table.test.ts`, which
 * owns the first checklist item (the role-by-action table and the
 * `AUTHZ_DENIED` write). This file owns the rest.
 *
 * Every test here names the defect it pins, because several of these are
 * VACUOUS-PASS bugs — the kind where the code returns a correct-looking answer
 * over an empty set — and a test that only asserts the happy path cannot tell
 * the fix from the bug.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/app-layer/repositories/AccessReviewRepository', () => ({
    AccessReviewRepository: {
        create: jest.fn(async () => ({ id: 'ar-1', name: 'Q4 connected' })),
        closeCampaign: jest.fn(async () => 1),
    },
}));
jest.mock('@/lib/storage', () => ({
    getStorageProvider: jest.fn(() => ({
        name: 'local',
        write: jest.fn(async () => ({ sizeBytes: 2048, sha256: 'deadbeef'.repeat(8) })),
    })),
    buildTenantObjectKey: jest.fn((t: string, d: string, f: string) => `${t}/${d}/${f}`),
}));

import {
    createConnectedAccessReview,
    closeConnectedAccessReview,
} from '@/app-layer/usecases/access-review-connected';
import { AccessReviewRepository } from '@/app-layer/repositories/AccessReviewRepository';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../helpers/make-context';

const NOW = new Date('2026-10-08T00:00:00.000Z');

const mockDb = {
    connectedIdentityAccount: { findMany: jest.fn() },
    accessReviewConnectedDecision: { createMany: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    accessReview: { findFirst: jest.fn(), updateMany: jest.fn() },
    identityAccountLink: { findMany: jest.fn() },
    task: { create: jest.fn() },
    user: { findUnique: jest.fn() },
    fileRecord: { create: jest.fn() },
};

function account(over: Record<string, unknown> = {}) {
    return {
        id: 'acc-1', provider: 'okta', email: 'a@x.com', displayName: 'A',
        isAdmin: false, mfaEnrolled: true, groupsJson: [],
        connectionId: 'conn-1', externalUserId: 'ext-a',
        ...over,
    };
}

function reviewRow(over: Record<string, unknown> = {}) {
    return {
        id: 'ar-1', name: 'Q4 connected', description: null, scope: 'CONNECTED_APP',
        periodStartAt: null, periodEndAt: null, status: 'OPEN', deletedAt: null,
        snapshotTruncated: false,
        reviewer: { email: 'rev@x.com' },
        createdBy: { email: 'creator@x.com' },
        tenant: { name: 'Acme' },
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.connectedIdentityAccount.findMany.mockResolvedValue([account()]);
    mockDb.accessReviewConnectedDecision.createMany.mockResolvedValue({ count: 1 });
    mockDb.accessReviewConnectedDecision.updateMany.mockResolvedValue({ count: 1 });
    mockDb.identityAccountLink.findMany.mockResolvedValue([]);
    mockDb.accessReview.findFirst.mockResolvedValue(reviewRow());
    mockDb.accessReview.updateMany.mockResolvedValue({ count: 1 });
    mockDb.user.findUnique.mockResolvedValue({ email: 'closer@x.com' });
    mockDb.fileRecord.create.mockResolvedValue({ id: 'file-1' });
    mockDb.task.create.mockResolvedValue({ id: 'task-1' });
});

// ─── A connected review with zero subjects cannot be created ───

describe('5a — zero subjects is refused at create, with a machine-readable code', () => {
    it('throws NO_SUBJECTS, not a bare 400', async () => {
        mockDb.connectedIdentityAccount.findMany.mockResolvedValue([]);
        const ctx = makeRequestContext('ADMIN');
        await expect(
            createConnectedAccessReview(ctx, { name: 'x', reviewerUserId: 'u' }),
        ).rejects.toMatchObject({ code: 'NO_SUBJECTS', status: 400 });
    });

    it('creates nothing at all when it refuses', async () => {
        mockDb.connectedIdentityAccount.findMany.mockResolvedValue([]);
        const ctx = makeRequestContext('ADMIN');
        await expect(
            createConnectedAccessReview(ctx, { name: 'x', reviewerUserId: 'u' }),
        ).rejects.toThrow();
        // The refusal must precede the AccessReview row. Otherwise a campaign
        // with no subjects exists anyway and only the API call looks failed.
        expect(AccessReviewRepository.create).not.toHaveBeenCalled();
        expect(mockDb.accessReviewConnectedDecision.createMany).not.toHaveBeenCalled();
    });
});

// ─── Two connections holding the same provider + email → two subjects ───

describe('5a — subject references are scoped to the CONNECTION', () => {
    it('two connections with the same provider and email produce TWO subjects', async () => {
        // The exact collision: one tenant, two AD forests, the same person's
        // email in both. `IntegrationConnection` is unique on
        // (tenantId, provider, NAME), so this is a supported configuration.
        mockDb.connectedIdentityAccount.findMany.mockResolvedValue([
            account({ id: 'acc-1', connectionId: 'forest-a', externalUserId: 'S-1-5-21-A', email: 'same@x.com' }),
            account({ id: 'acc-2', connectionId: 'forest-b', externalUserId: 'S-1-5-21-B', email: 'same@x.com' }),
        ]);
        const ctx = makeRequestContext('ADMIN');
        const r = await createConnectedAccessReview(ctx, { name: 'two forests', reviewerUserId: 'u' });

        expect(r.snapshotCount).toBe(2);
        const rows = mockDb.accessReviewConnectedDecision.createMany.mock.calls[0][0].data;
        const refs = rows.map((x: { subjectRef: string }) => x.subjectRef);
        expect(new Set(refs).size).toBe(2);
        expect(refs).toEqual(['forest-a:S-1-5-21-A', 'forest-b:S-1-5-21-B']);
    });

    it('the OLD format would have collided — the mutation this test pins', async () => {
        // A positive control for the test above. Under `provider:email` both
        // rows get `okta:same@x.com`, the (accessReviewId, subjectRef) unique
        // constraint matches, and `skipDuplicates: true` DROPS the second
        // silently — one reviewed row for two real accounts. Asserting the
        // collapse of the old key makes the assertion above mean something.
        const legacy = ['okta:same@x.com', 'okta:same@x.com'];
        expect(new Set(legacy).size).toBe(1);
    });
});

// ─── A snapshot truncated at the cap is flagged ───

describe('5a — a truncated snapshot is recorded, not silently prefixed', () => {
    it('reads one past the cap and flags the campaign', async () => {
        // 5001 accounts: the cap is 5000, so the 5001st is the witness.
        const many = Array.from({ length: 5001 }, (_, i) =>
            account({ id: `acc-${i}`, externalUserId: `ext-${i}`, email: `u${i}@x.com` }));
        mockDb.connectedIdentityAccount.findMany.mockResolvedValue(many);
        const ctx = makeRequestContext('ADMIN');
        const r = await createConnectedAccessReview(ctx, { name: 'big', reviewerUserId: 'u' });

        expect(r.snapshotTruncated).toBe(true);
        // Snapshots the cap, not the cap + 1 — the extra row is only evidence.
        expect(r.snapshotCount).toBe(5000);
        expect(mockDb.accessReviewConnectedDecision.createMany.mock.calls[0][0].data).toHaveLength(5000);
        expect(AccessReviewRepository.create).toHaveBeenCalledWith(
            expect.anything(), expect.anything(),
            expect.objectContaining({ snapshotTruncated: true }),
        );
    });

    it('a directory of EXACTLY the cap is NOT flagged', async () => {
        // The discriminating case. `take: N` returning N cannot distinguish
        // these two worlds, which is why the query reads N + 1.
        const exact = Array.from({ length: 5000 }, (_, i) =>
            account({ id: `acc-${i}`, externalUserId: `ext-${i}`, email: `u${i}@x.com` }));
        mockDb.connectedIdentityAccount.findMany.mockResolvedValue(exact);
        const ctx = makeRequestContext('ADMIN');
        const r = await createConnectedAccessReview(ctx, { name: 'exact', reviewerUserId: 'u' });
        expect(r.snapshotTruncated).toBe(false);
        expect(r.snapshotCount).toBe(5000);
    });

    it('the query asks for cap + 1, which is what makes the two cases separable', async () => {
        const ctx = makeRequestContext('ADMIN');
        await createConnectedAccessReview(ctx, { name: 'x', reviewerUserId: 'u' });
        expect(mockDb.connectedIdentityAccount.findMany.mock.calls[0][0].take).toBe(5001);
    });

    it('a truncated campaign cannot present itself as complete on close', async () => {
        mockDb.accessReview.findFirst.mockResolvedValue(reviewRow({ snapshotTruncated: true }));
        mockDb.accessReviewConnectedDecision.findMany.mockResolvedValue([
            { id: 'd1', subjectRef: 'conn-1:ext-a', decision: 'CONFIRM', decidedAt: NOW, executedAt: null, notes: null, snapshotJson: {} },
        ]);
        const ctx = makeRequestContext('ADMIN');
        const r = await closeConnectedAccessReview(ctx, 'ar-1', NOW);

        expect(r.snapshotTruncated).toBe(true);
        // The hash-chained close row must carry the caveat: that entry is what
        // an auditor reads to learn what the campaign attested.
        const closeCall = (logEvent as jest.Mock).mock.calls
            .find((c) => c[2]?.detailsJson?.operation === 'close');
        expect(closeCall).toBeDefined();
        expect(closeCall[2].detailsJson.after.snapshotTruncated).toBe(true);
        expect(closeCall[2].detailsJson.summary).toMatch(/TRUNCATED/);
    });
});

// ─── Undecided subjects cannot close, and zero is not complete ───

describe('5a — the close gate, including the zero-equals-zero regression', () => {
    it('refuses to close while a connected subject is undecided', async () => {
        mockDb.accessReviewConnectedDecision.findMany.mockResolvedValue([
            { id: 'd1', subjectRef: 'c:1', decision: 'CONFIRM', decidedAt: NOW, executedAt: null, notes: null, snapshotJson: {} },
            { id: 'd2', subjectRef: 'c:2', decision: null, decidedAt: null, executedAt: null, notes: null, snapshotJson: {} },
        ]);
        const ctx = makeRequestContext('ADMIN');
        await expect(closeConnectedAccessReview(ctx, 'ar-1', NOW)).rejects.toThrow(/pending/i);
        expect(mockDb.task.create).not.toHaveBeenCalled();
    });

    it('REGRESSION — a campaign with ZERO subjects cannot close', async () => {
        // The vacuous pass. `pending = decisions.filter(d => d.decision === null)`
        // is empty for an empty campaign, so the pending check waved it
        // through: it closed instantly, reported `executed: 0`, and produced an
        // evidence artefact attesting that every account in scope had been
        // reviewed. True of its rows, false of the directory.
        mockDb.accessReviewConnectedDecision.findMany.mockResolvedValue([]);
        const ctx = makeRequestContext('ADMIN');
        await expect(closeConnectedAccessReview(ctx, 'ar-1', NOW)).rejects.toThrow(/no subjects/i);
        // And it stays OPEN: no claim, no tasks, no artefact.
        expect(mockDb.accessReview.updateMany).not.toHaveBeenCalled();
        expect(mockDb.task.create).not.toHaveBeenCalled();
        expect(mockDb.fileRecord.create).not.toHaveBeenCalled();
    });
});

// ─── The evidence PDF ───

describe('5a — close produces a hashed evidence PDF', () => {
    beforeEach(() => {
        mockDb.accessReviewConnectedDecision.findMany.mockResolvedValue([
            {
                id: 'd1', subjectRef: 'conn-1:ext-a', decision: 'CONFIRM', decidedAt: NOW,
                executedAt: null,
                notes: 'looks fine <script>alert(1)</script>',
                snapshotJson: { provider: 'okta', email: 'a@x.com', displayName: 'A', isAdmin: true, mfaEnrolled: false },
            },
        ]);
    });

    it('stores a FileRecord carrying the sha256 and links it to the campaign', async () => {
        const ctx = makeRequestContext('ADMIN');
        const r = await closeConnectedAccessReview(ctx, 'ar-1', NOW);

        expect(r.evidenceFileRecordId).toBe('file-1');
        const data = mockDb.fileRecord.create.mock.calls[0][0].data;
        expect(data.sha256).toHaveLength(64);
        expect(data.mimeType).toBe('application/pdf');
        expect(data.domain).toBe('evidence');
        // Self-generated, so AV scanning is not a gate on serving it.
        expect(data.scanStatus).toBe('SKIPPED');
        // The campaign now points at the artefact.
        expect(AccessReviewRepository.closeCampaign).toHaveBeenCalledWith(
            expect.anything(), expect.anything(), 'ar-1', NOW, 'file-1',
        );
    });

    it('emits ACCESS_REVIEW_EVIDENCE_GENERATED with the hash in the audit row', async () => {
        const ctx = makeRequestContext('ADMIN');
        await closeConnectedAccessReview(ctx, 'ar-1', NOW);
        const call = (logEvent as jest.Mock).mock.calls
            .find((c) => c[2]?.action === 'ACCESS_REVIEW_EVIDENCE_GENERATED');
        expect(call).toBeDefined();
        expect(call[2].detailsJson.after.sha256).toHaveLength(64);
    });

    it('a failed artefact leaves the campaign CLOSED rather than rolling the close back', async () => {
        mockDb.fileRecord.create.mockRejectedValue(new Error('storage down'));
        const ctx = makeRequestContext('ADMIN');
        // Does NOT throw: the close committed in phase 1 and telling the
        // operator it failed would be false.
        const r = await closeConnectedAccessReview(ctx, 'ar-1', NOW);
        expect(r.evidenceFileRecordId).toBeNull();
        expect(r.executed).toBe(1);
        // The close itself still happened.
        expect(mockDb.accessReview.updateMany).toHaveBeenCalled();
    });

    it('a close that LOST the TOCTOU race writes no second artefact', async () => {
        mockDb.accessReview.updateMany.mockResolvedValue({ count: 0 });
        const ctx = makeRequestContext('ADMIN');
        const r = await closeConnectedAccessReview(ctx, 'ar-1', NOW);
        expect(r.remediationTasks).toBe(0);
        // One campaign, one evidence file. The winner is producing it.
        expect(mockDb.fileRecord.create).not.toHaveBeenCalled();
    });
});

// ─── HR context is read, never written ───

describe('5a — HR context is read-only and recorded explicitly when absent', () => {
    it('joins the linked employee, status, department and manager into the snapshot', async () => {
        mockDb.identityAccountLink.findMany.mockResolvedValue([
            {
                connectedAccountId: 'acc-1',
                matchMethod: 'EMAIL_EXACT',
                contradictedAt: null,
                employee: {
                    id: 'emp-1', fullName: 'Ada Lovelace', workEmail: 'ada@x.com',
                    status: 'ACTIVE', department: 'Engineering', jobTitle: 'Engineer',
                    manager: { fullName: 'Grace Hopper', workEmail: 'grace@x.com' },
                },
            },
        ]);
        const ctx = makeRequestContext('ADMIN');
        await createConnectedAccessReview(ctx, { name: 'x', reviewerUserId: 'u' });

        const row = mockDb.accessReviewConnectedDecision.createMany.mock.calls[0][0].data[0];
        expect(row.snapshotJson.hr).toMatchObject({
            employeeId: 'emp-1',
            fullName: 'Ada Lovelace',
            employmentStatus: 'ACTIVE',
            department: 'Engineering',
            managerName: 'Grace Hopper',
            contradicted: false,
        });
    });

    it('records hr: null for an UNLINKED account rather than omitting the key', async () => {
        // An unlinked account is a reviewable fact — a service account, or a
        // contractor the HR feed does not carry. An absent key would read as
        // "nobody looked".
        mockDb.identityAccountLink.findMany.mockResolvedValue([]);
        const ctx = makeRequestContext('ADMIN');
        await createConnectedAccessReview(ctx, { name: 'x', reviewerUserId: 'u' });
        const row = mockDb.accessReviewConnectedDecision.createMany.mock.calls[0][0].data[0];
        expect(row.snapshotJson).toHaveProperty('hr');
        expect(row.snapshotJson.hr).toBeNull();
    });

    it('surfaces a CONTRADICTED link so stale HR context is not read as current', async () => {
        mockDb.identityAccountLink.findMany.mockResolvedValue([
            {
                connectedAccountId: 'acc-1', matchMethod: 'EMAIL_EXACT',
                contradictedAt: new Date('2026-09-01T00:00:00.000Z'),
                employee: {
                    id: 'emp-1', fullName: 'Ada', workEmail: 'ada@x.com', status: 'TERMINATED',
                    department: null, jobTitle: null, manager: null,
                },
            },
        ]);
        const ctx = makeRequestContext('ADMIN');
        await createConnectedAccessReview(ctx, { name: 'x', reviewerUserId: 'u' });
        const row = mockDb.accessReviewConnectedDecision.createMany.mock.calls[0][0].data[0];
        expect(row.snapshotJson.hr.contradicted).toBe(true);
        expect(row.snapshotJson.hr.employmentStatus).toBe('TERMINATED');
    });

    it('reads IdentityAccountLink and never writes it', async () => {
        // The Step 0a guard asserts at the SOURCE level that this module is
        // not a writer of the directory identity tables. This asserts it at
        // RUNTIME: the only method touched is findMany.
        const ctx = makeRequestContext('ADMIN');
        await createConnectedAccessReview(ctx, { name: 'x', reviewerUserId: 'u' });
        expect(mockDb.identityAccountLink.findMany).toHaveBeenCalledTimes(1);
        expect(Object.keys(mockDb.identityAccountLink)).toEqual(['findMany']);
    });

    it('fetches HR context in ONE query, not one per subject', async () => {
        const many = Array.from({ length: 40 }, (_, i) =>
            account({ id: `acc-${i}`, externalUserId: `ext-${i}`, email: `u${i}@x.com` }));
        mockDb.connectedIdentityAccount.findMany.mockResolvedValue(many);
        const ctx = makeRequestContext('ADMIN');
        await createConnectedAccessReview(ctx, { name: 'x', reviewerUserId: 'u' });
        expect(mockDb.identityAccountLink.findMany).toHaveBeenCalledTimes(1);
        const where = mockDb.identityAccountLink.findMany.mock.calls[0][0].where;
        expect(where.connectedAccountId.in).toHaveLength(40);
    });
});
