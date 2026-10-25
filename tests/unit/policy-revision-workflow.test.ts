/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Revising a PUBLISHED policy, and the approval flow around it (#4127).
 *
 * Before this, the editor saved a change to a live policy as a proposal and
 * every route onward from it was refused: requesting approval 409'd while the
 * policy was PUBLISHED, so there was nothing to approve and nothing to
 * publish. The only way to change a live policy was to archive and restore
 * it, which withdrew it.
 *
 * The revision now goes request → approve → publish while the policy stays
 * PUBLISHED; the live version keeps serving acknowledgements until the
 * revision is published, and publishing it re-requests acknowledgement.
 *
 * Also covered here: the approval-request email audience, and the decision
 * comment reaching the store.
 */

const mockDb: any = {};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

const mockPolicyRepo = {
    getById: jest.fn(),
    updateStatus: jest.fn(),
    setCurrentVersion: jest.fn(),
};
const mockVersionRepo = { getById: jest.fn() };
const mockApprovalRepo = {
    request: jest.fn(),
    decide: jest.fn(),
    getById: jest.fn(),
    latestApproved: jest.fn(),
    findPending: jest.fn(),
    supersedePending: jest.fn(),
};

jest.mock('@/app-layer/repositories/PolicyRepository', () => ({ PolicyRepository: mockPolicyRepo }));
jest.mock('@/app-layer/repositories/PolicyVersionRepository', () => ({ PolicyVersionRepository: mockVersionRepo }));
jest.mock('@/app-layer/repositories/PolicyApprovalRepository', () => ({ PolicyApprovalRepository: mockApprovalRepo }));
jest.mock('@/app-layer/repositories/PolicyTemplateRepository', () => ({ PolicyTemplateRepository: {} }));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/app-layer/notifications/enqueue', () => ({ enqueueEmail: jest.fn() }));
jest.mock('@/app-layer/usecases/policy-sharepoint-sync', () => ({ pushPolicyToSharePoint: jest.fn() }));
jest.mock('@/lib/observability/business-metrics', () => ({ recordPolicyPublished: jest.fn() }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { logEvent } from '@/app-layer/events/audit';
import { enqueueEmail } from '@/app-layer/notifications/enqueue';
import {
    requestPolicyApproval,
    decidePolicyApproval,
    publishPolicy,
    rollbackPolicy,
} from '@/app-layer/usecases/policy';
import { makeRequestContext } from '../helpers/make-context';

const editor = makeRequestContext('EDITOR', { userId: 'u-editor' });
const admin = makeRequestContext('ADMIN', { userId: 'u-admin' });

const v1 = { id: 'v1', policyId: 'p1', versionNumber: 1, changeSummary: null };
const v2 = { id: 'v2', policyId: 'p1', versionNumber: 2, changeSummary: null };
const v3 = { id: 'v3', policyId: 'p1', versionNumber: 3, changeSummary: null };
const VERSIONS: Record<string, typeof v1> = { v1, v2, v3 };

/** A PUBLISHED policy with v1 live and v2 / v3 saved after it. */
function publishedPolicy(over: Record<string, unknown> = {}) {
    return {
        id: 'p1',
        title: 'Access Control',
        status: 'PUBLISHED',
        currentVersionId: 'v1',
        currentVersion: v1,
        versions: [v3, v2, v1],
        approvals: [] as any[],
        lifecycleVersion: 2,
        lifecycleHistoryJson: [],
        ...over,
    };
}

const actions = () => (logEvent as jest.Mock).mock.calls.map((c) => c[2].action);
const event = (action: string) => (logEvent as jest.Mock).mock.calls.map((c) => c[2]).find((e) => e.action === action);

beforeEach(() => {
    jest.clearAllMocks();
    mockVersionRepo.getById.mockImplementation(async (_db: any, id: string) => VERSIONS[id] ?? null);
    mockApprovalRepo.findPending.mockResolvedValue([]);
    mockApprovalRepo.supersedePending.mockResolvedValue({ count: 0 });
    mockApprovalRepo.request.mockResolvedValue({ id: 'a-new' });
    mockDb.user = { findUnique: jest.fn().mockResolvedValue({ name: 'Requester', email: 'req@example.test' }) };
    mockDb.tenantMembership = { findMany: jest.fn().mockResolvedValue([]) };
    mockDb.policyVersion = { findFirst: jest.fn().mockResolvedValue({ createdById: 'u-author' }) };
    mockDb.policy = { update: jest.fn() };
    mockDb.policyAcknowledgementAssignment = { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() };
    mockDb.notification = { create: jest.fn().mockResolvedValue({}) };
});

describe('requestPolicyApproval on a PUBLISHED policy', () => {
    it('accepts a revision and leaves the policy PUBLISHED', async () => {
        mockPolicyRepo.getById.mockResolvedValue(publishedPolicy());

        await expect(requestPolicyApproval(editor, 'p1', 'v2')).resolves.toEqual({ id: 'a-new' });

        expect(mockApprovalRepo.request).toHaveBeenCalledWith(mockDb, editor, 'p1', 'v2');
        // The live version keeps serving acknowledgements: no move to IN_REVIEW.
        expect(mockPolicyRepo.updateStatus).not.toHaveBeenCalled();
        expect(event('POLICY_APPROVAL_REQUESTED').detailsJson).toEqual(
            expect.objectContaining({ fromStatus: 'PUBLISHED', toStatus: 'PUBLISHED' }),
        );
    });

    it('still refuses the live version itself, and an older one', async () => {
        mockPolicyRepo.getById.mockResolvedValue(publishedPolicy({ currentVersionId: 'v2', currentVersion: v2 }));

        await expect(requestPolicyApproval(editor, 'p1', 'v2')).rejects.toThrow(/already published/i);
        await expect(requestPolicyApproval(editor, 'p1', 'v1')).rejects.toThrow(/newer than the published one/i);
        expect(mockApprovalRepo.request).not.toHaveBeenCalled();
        expect(mockPolicyRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('still allows only one open request per policy', async () => {
        mockPolicyRepo.getById.mockResolvedValue(publishedPolicy());
        mockApprovalRepo.findPending.mockResolvedValue([{ id: 'a-open', policyVersionId: 'v2' }]);

        await expect(requestPolicyApproval(editor, 'p1', 'v3')).rejects.toThrow(/awaiting a decision/i);
    });
});

describe('approval-request emails', () => {
    /** Applies the `where` the usecase passes, like the database would. */
    const MEMBERS = [
        { role: 'OWNER', status: 'ACTIVE', user: { email: 'owner@example.test', name: 'Owner' } },
        { role: 'ADMIN', status: 'ACTIVE', user: { email: 'admin@example.test', name: 'Admin' } },
        { role: 'ADMIN', status: 'DEACTIVATED', user: { email: 'gone@example.test', name: 'Gone' } },
        { role: 'EDITOR', status: 'ACTIVE', user: { email: 'editor@example.test', name: 'Editor' } },
    ];
    const matches = (value: string, cond: unknown) =>
        cond === undefined ||
        (typeof cond === 'string' ? value === cond : ((cond as { in: string[] }).in ?? []).includes(value));

    it('go to every ACTIVE Owner and Admin — not deactivated Admins, not Editors', async () => {
        mockPolicyRepo.getById.mockResolvedValue({ ...publishedPolicy(), status: 'DRAFT' });
        mockDb.tenantMembership.findMany.mockImplementation(async ({ where }: any) =>
            MEMBERS.filter((m) => matches(m.role, where.role) && matches(m.status, where.status)),
        );

        await requestPolicyApproval(editor, 'p1', 'v3');

        const recipients = (enqueueEmail as jest.Mock).mock.calls.map((c) => c[1].toEmail).sort();
        expect(recipients).toEqual(['admin@example.test', 'owner@example.test']);
        expect((enqueueEmail as jest.Mock).mock.calls[0][1].type).toBe('POLICY_APPROVAL_REQUESTED');
    });
});

describe('decidePolicyApproval on a revision', () => {
    function revisionApproval(over: Record<string, unknown> = {}) {
        return {
            id: 'a2',
            policyId: 'p1',
            policyVersionId: 'v2',
            status: 'PENDING',
            requestedByUserId: 'u-editor',
            policyVersion: { versionNumber: 2 },
            policy: {
                id: 'p1',
                tenantId: admin.tenantId,
                title: 'Access Control',
                status: 'PUBLISHED',
                currentVersionId: 'v1',
                currentVersion: { id: 'v1', versionNumber: 1 },
            },
            ...over,
        };
    }

    it('approving keeps the policy PUBLISHED', async () => {
        mockApprovalRepo.getById.mockResolvedValue(revisionApproval());
        mockApprovalRepo.decide.mockResolvedValue({ id: 'a2', status: 'APPROVED' });

        await decidePolicyApproval(admin, 'p1', 'a2', { decision: 'APPROVED' });

        expect(mockApprovalRepo.decide).toHaveBeenCalledWith(mockDb, admin, 'a2', 'APPROVED', undefined);
        expect(mockPolicyRepo.updateStatus).not.toHaveBeenCalled();
        expect(event('POLICY_APPROVED').detailsJson).toEqual(
            expect.objectContaining({ fromStatus: 'PUBLISHED', toStatus: 'PUBLISHED' }),
        );
    });

    it('rejecting keeps the policy PUBLISHED too', async () => {
        mockApprovalRepo.getById.mockResolvedValue(revisionApproval());
        mockApprovalRepo.decide.mockResolvedValue({ id: 'a2', status: 'REJECTED' });

        await decidePolicyApproval(admin, 'p1', 'a2', { decision: 'REJECTED', comment: 'Not yet' });

        expect(mockPolicyRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('keeps the four-eyes rule: the requester cannot approve their own revision', async () => {
        mockApprovalRepo.getById.mockResolvedValue(revisionApproval({ requestedByUserId: admin.userId }));

        await expect(decidePolicyApproval(admin, 'p1', 'a2', { decision: 'APPROVED' })).rejects.toThrow(
            /separation of duties/i,
        );
        expect(mockApprovalRepo.decide).not.toHaveBeenCalled();
    });

    it('...nor the author of the version', async () => {
        mockApprovalRepo.getById.mockResolvedValue(revisionApproval());
        mockDb.policyVersion.findFirst.mockResolvedValue({ createdById: admin.userId });

        await expect(decidePolicyApproval(admin, 'p1', 'a2', { decision: 'APPROVED' })).rejects.toThrow(/authored/i);
    });

    it('a PENDING row for the live version is still stale', async () => {
        mockApprovalRepo.getById.mockResolvedValue(
            revisionApproval({ policyVersionId: 'v1', policyVersion: { versionNumber: 1 } }),
        );

        await expect(decidePolicyApproval(admin, 'p1', 'a2', { decision: 'REJECTED' })).rejects.toThrow(
            /no longer current/i,
        );
    });
});

describe('the reviewer\'s comment', () => {
    const inReview = {
        id: 'a1',
        policyId: 'p1',
        policyVersionId: 'v1',
        status: 'PENDING',
        requestedByUserId: 'u-editor',
        policyVersion: { versionNumber: 1 },
        policy: { id: 'p1', tenantId: admin.tenantId, title: 'Access Control', status: 'IN_REVIEW' },
    };

    it('is stored with the decision, sanitised, and sent in the decision email', async () => {
        mockApprovalRepo.getById.mockResolvedValue(inReview);
        mockApprovalRepo.decide.mockResolvedValue({ id: 'a1', status: 'REJECTED' });

        await decidePolicyApproval(admin, 'p1', 'a1', {
            decision: 'REJECTED',
            comment: '  Section 3 is out of date <script>alert(1)</script> ',
        });

        expect(mockApprovalRepo.decide).toHaveBeenCalledWith(mockDb, admin, 'a1', 'REJECTED', 'Section 3 is out of date');
        expect((enqueueEmail as jest.Mock).mock.calls[0][1].payload.comment).toBe('Section 3 is out of date');
    });

    it('a blank comment is no comment', async () => {
        mockApprovalRepo.getById.mockResolvedValue(inReview);
        mockApprovalRepo.decide.mockResolvedValue({ id: 'a1', status: 'APPROVED' });

        await decidePolicyApproval(admin, 'p1', 'a1', { decision: 'APPROVED', comment: '   ' });

        expect(mockApprovalRepo.decide).toHaveBeenCalledWith(mockDb, admin, 'a1', 'APPROVED', undefined);
    });
});

describe('publishPolicy on a PUBLISHED policy', () => {
    const approvedRevision = [
        { policyVersionId: 'v1', status: 'APPROVED', createdAt: new Date('2026-01-01'), decidedAt: new Date('2026-01-02') },
        { policyVersionId: 'v2', status: 'APPROVED', createdAt: new Date('2026-02-01'), decidedAt: new Date('2026-02-02') },
    ];

    it('publishes an approved revision without a bypass, and re-requests acknowledgement', async () => {
        mockPolicyRepo.getById.mockResolvedValue(publishedPolicy({ approvals: approvedRevision }));
        mockDb.policyAcknowledgementAssignment.findMany.mockResolvedValue([
            { userId: 'u-staff', assignedById: 'u-admin' },
        ]);

        await publishPolicy(admin, 'p1', 'v2');

        expect(mockPolicyRepo.setCurrentVersion).toHaveBeenCalledWith(mockDb, admin, 'p1', 'v2');
        expect(mockPolicyRepo.updateStatus).toHaveBeenCalledWith(mockDb, admin, 'p1', 'PUBLISHED');
        // The existing carry-forward: v1's acknowledgement roster moves to v2.
        expect(mockDb.policyAcknowledgementAssignment.createMany).toHaveBeenCalledWith({
            data: [{ policyVersionId: 'v2', userId: 'u-staff', assignedById: 'u-admin' }],
            skipDuplicates: true,
        });
        expect(mockDb.notification.create).toHaveBeenCalledTimes(1);
        // An approved publish, not an emergency one.
        expect(actions()).toContain('POLICY_PUBLISHED');
        expect(actions()).not.toContain('POLICY_PUBLISH_BYPASS');
        // The outgoing live version is kept for rollback.
        const history = mockDb.policy.update.mock.calls[0][0].data.lifecycleHistoryJson;
        expect(history).toEqual([expect.objectContaining({ versionId: 'v1', versionNumber: 1 })]);
    });

    it('refuses a version that is not the approved revision', async () => {
        mockPolicyRepo.getById.mockResolvedValue(publishedPolicy({ approvals: approvedRevision }));

        await expect(publishPolicy(admin, 'p1', 'v3')).rejects.toThrow(/not the version that was approved/i);
        expect(mockPolicyRepo.setCurrentVersion).not.toHaveBeenCalled();
    });

    it('refuses a revision nobody approved', async () => {
        mockPolicyRepo.getById.mockResolvedValue(publishedPolicy());

        await expect(publishPolicy(admin, 'p1', 'v2')).rejects.toThrow(/has not been approved/i);
    });

    it('refuses a revision whose approval a later request has replaced', async () => {
        mockPolicyRepo.getById.mockResolvedValue(
            publishedPolicy({
                approvals: [
                    ...approvedRevision,
                    { policyVersionId: 'v3', status: 'REJECTED', createdAt: new Date('2026-03-01'), decidedAt: new Date('2026-03-02') },
                ],
            }),
        );

        await expect(publishPolicy(admin, 'p1', 'v2')).rejects.toThrow(/has not been approved/i);
    });

    it('still publishes any version with an emergency bypass', async () => {
        mockPolicyRepo.getById.mockResolvedValue(publishedPolicy());

        await publishPolicy(admin, 'p1', 'v3', { bypassApprovalReason: 'Incident IR-7' });

        expect(mockPolicyRepo.setCurrentVersion).toHaveBeenCalledWith(mockDb, admin, 'p1', 'v3');
        expect(actions()).toContain('POLICY_PUBLISH_BYPASS');
    });
});

describe('rollbackPolicy closes the approval requests it makes stale', () => {
    it('supersedes open requests for the restored version and older ones only', async () => {
        mockPolicyRepo.getById.mockResolvedValue(
            publishedPolicy({
                currentVersionId: 'v1',
                currentVersion: v1,
                lifecycleVersion: 4,
                lifecycleHistoryJson: [{ version: 3, versionId: 'v2', versionNumber: 2, changeSummary: null }],
            }),
        );
        mockApprovalRepo.supersedePending.mockResolvedValue({ count: 1 });

        await rollbackPolicy(admin, 'p1');

        expect(mockPolicyRepo.setCurrentVersion).toHaveBeenCalledWith(mockDb, admin, 'p1', 'v2');
        const [, , policyId, , versionIds] = mockApprovalRepo.supersedePending.mock.calls[0];
        expect(policyId).toBe('p1');
        // v3 is still a revision of the restored v2, so its request stands.
        expect([...versionIds].sort()).toEqual(['v1', 'v2']);
        expect(actions()).toContain('POLICY_APPROVAL_SUPERSEDED');
    });
});
