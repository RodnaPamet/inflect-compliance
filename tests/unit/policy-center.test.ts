/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Policy Center — Unit + Integration Tests
 *
 * Tests authorization matrix, version numbering, tenant isolation,
 * and the approval/publish workflow.
 */
import { AppError } from '@/lib/errors/types';

// ─── Mock Prisma + DB context ───

const mockDb: any = {};
const mockCtx = (role: string, overrides?: any) => ({
    requestId: 'test-req-id',
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    role,
    permissions: {
        canRead: true,
        canWrite: ['ADMIN', 'EDITOR'].includes(role),
        canAdmin: role === 'ADMIN',
        canAudit: ['ADMIN', 'AUDITOR'].includes(role),
        canExport: role === 'ADMIN',
    },
    ...overrides,
});

// Mock runInTenantContext to just call the callback with mockDb
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, cb: any) => cb(mockDb)),
}));

// Mock logEvent to a no-op
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { logEvent: mockLogEvent } = require('@/app-layer/events/audit');

// Mock repositories
const mockPolicyRepo = {
    list: jest.fn(),
    getById: jest.fn(),
    getBySlug: jest.fn(),
    create: jest.fn(),
    updateMetadata: jest.fn(),
    updateStatus: jest.fn(),
    setCurrentVersion: jest.fn(),
};

const mockVersionRepo = {
    create: jest.fn(),
    listByPolicy: jest.fn(),
    getById: jest.fn(),
};

const mockApprovalRepo = {
    request: jest.fn(),
    decide: jest.fn(),
    getById: jest.fn(),
    listPending: jest.fn(),
    // Lifecycle-integrity helpers: publish binds to the approved version,
    // requestPolicyApproval dedupes open requests, and publish supersedes
    // whatever is still outstanding.
    latestApproved: jest.fn(),
    findPending: jest.fn(),
    supersedePending: jest.fn(),
};

const mockTemplateRepo = {
    list: jest.fn(),
    getById: jest.fn(),
};

jest.mock('@/app-layer/repositories/PolicyRepository', () => ({
    PolicyRepository: mockPolicyRepo,
}));
jest.mock('@/app-layer/repositories/PolicyVersionRepository', () => ({
    PolicyVersionRepository: mockVersionRepo,
}));
jest.mock('@/app-layer/repositories/PolicyApprovalRepository', () => ({
    PolicyApprovalRepository: mockApprovalRepo,
}));
jest.mock('@/app-layer/repositories/PolicyTemplateRepository', () => ({
    PolicyTemplateRepository: mockTemplateRepo,
}));

import * as usecases from '@/app-layer/usecases/policy';

beforeEach(() => {
    jest.clearAllMocks();
    mockPolicyRepo.getBySlug.mockResolvedValue(null);
    // publishPolicy writes lifecycle fields directly on the tenant db (Prompt-3.1).
    mockDb.policy = { update: jest.fn() };
    // decidePolicyApproval's author-aware SoD reads the target version's
    // author off the tenant db. Default to an author who is NOT the approver
    // so approval is allowed; individual tests can override.
    mockDb.policyVersion = { findFirst: jest.fn().mockResolvedValue({ createdById: 'author-not-approver' }) };
    // Owner validation intersects a body-supplied ownerUserId with ACTIVE
    // membership; default to "is a member" so unrelated tests are unaffected.
    mockDb.tenantMembership = { findFirst: jest.fn().mockResolvedValue({ userId: 'user-1' }) };
    // No competing open request by default (the dedupe guard).
    mockApprovalRepo.findPending.mockResolvedValue([]);
    // Nothing outstanding to supersede on publish by default.
    mockApprovalRepo.supersedePending.mockResolvedValue({ count: 0 });
    // Publish binds to the approved version — default the approval to the
    // version the publish tests actually pass ('v1').
    mockApprovalRepo.latestApproved.mockResolvedValue({ id: 'a1', policyVersionId: 'v1' });
});

// ─── Authorization Matrix ───

describe('Policy Authorization Matrix', () => {
    const roles = ['ADMIN', 'EDITOR', 'READER', 'AUDITOR'];

    describe('listPolicies', () => {
        it.each(roles)('%s can list policies', async (role) => {
            mockPolicyRepo.list.mockResolvedValue([]);
            await expect(usecases.listPolicies(mockCtx(role))).resolves.toEqual([]);
        });
    });

    describe('getPolicy', () => {
        it.each(roles)('%s can get a policy', async (role) => {
            mockPolicyRepo.getById.mockResolvedValue({ id: 'p1', title: 'Test' });
            await expect(usecases.getPolicy(mockCtx(role), 'p1')).resolves.toBeDefined();
        });
    });

    describe('createPolicy', () => {
        it.each(['ADMIN', 'EDITOR'])('%s can create a policy', async (role) => {
            mockPolicyRepo.create.mockResolvedValue({ id: 'p1', title: 'New' });
            await expect(
                usecases.createPolicy(mockCtx(role), { title: 'New' })
            ).resolves.toBeDefined();
        });

        it.each(['READER', 'AUDITOR'])('%s cannot create a policy', async (role) => {
            await expect(
                usecases.createPolicy(mockCtx(role), { title: 'New' })
            ).rejects.toThrow(AppError);
        });
    });

    describe('createPolicyVersion', () => {
        it.each(['ADMIN', 'EDITOR'])('%s can create a version', async (role) => {
            mockPolicyRepo.getById.mockResolvedValue({ id: 'p1', status: 'DRAFT' });
            mockVersionRepo.create.mockResolvedValue({ id: 'v1', versionNumber: 1 });
            await expect(
                usecases.createPolicyVersion(mockCtx(role), 'p1', { contentType: 'MARKDOWN', contentText: '# Test' })
            ).resolves.toBeDefined();
        });

        it.each(['READER', 'AUDITOR'])('%s cannot create a version', async (role) => {
            await expect(
                usecases.createPolicyVersion(mockCtx(role), 'p1', { contentType: 'MARKDOWN', contentText: '# Test' })
            ).rejects.toThrow(AppError);
        });
    });

    describe('requestPolicyApproval', () => {
        it.each(['ADMIN', 'EDITOR'])('%s can request approval', async (role) => {
            mockPolicyRepo.getById.mockResolvedValue({ id: 'p1', status: 'DRAFT' });
            mockVersionRepo.getById.mockResolvedValue({ id: 'v1', policyId: 'p1' });
            mockApprovalRepo.request.mockResolvedValue({ id: 'a1' });
            await expect(
                usecases.requestPolicyApproval(mockCtx(role), 'p1', 'v1')
            ).resolves.toBeDefined();
        });

        it.each(['READER', 'AUDITOR'])('%s cannot request approval', async (role) => {
            await expect(
                usecases.requestPolicyApproval(mockCtx(role), 'p1', 'v1')
            ).rejects.toThrow(AppError);
        });
    });

    describe('decidePolicyApproval — ADMIN only', () => {
        it('ADMIN can approve', async () => {
            mockApprovalRepo.getById.mockResolvedValue({ id: 'a1', policy: { tenantId: 'tenant-1', status: 'IN_REVIEW' }, policyId: 'p1', status: 'PENDING' });
            mockApprovalRepo.decide.mockResolvedValue({ id: 'a1', status: 'APPROVED' });
            await expect(
                usecases.decidePolicyApproval(mockCtx('ADMIN'), 'p1', 'a1', { decision: 'APPROVED' })
            ).resolves.toBeDefined();
        });

        it.each(['EDITOR', 'READER', 'AUDITOR'])('%s cannot decide approval', async (role) => {
            await expect(
                usecases.decidePolicyApproval(mockCtx(role), 'p1', 'a1', { decision: 'APPROVED' })
            ).rejects.toThrow(AppError);
        });
    });

    describe('publishPolicy — ADMIN only', () => {
        it('ADMIN can publish an APPROVED policy', async () => {
            mockPolicyRepo.getById.mockResolvedValue({ id: 'p1', status: 'APPROVED' });
            mockVersionRepo.getById.mockResolvedValue({ id: 'v1', policyId: 'p1', versionNumber: 1 });
            await expect(
                usecases.publishPolicy(mockCtx('ADMIN'), 'p1', 'v1')
            ).resolves.toBeDefined();
        });

        it.each(['EDITOR', 'READER', 'AUDITOR'])('%s cannot publish', async (role) => {
            await expect(
                usecases.publishPolicy(mockCtx(role), 'p1', 'v1')
            ).rejects.toThrow(AppError);
        });

        // Audit S4 (2026-05-22) — the approval gate.
        it.each(['DRAFT', 'IN_REVIEW', 'REJECTED'])(
            'refuses %s status without bypassApprovalReason',
            async (status) => {
                mockPolicyRepo.getById.mockResolvedValue({ id: 'p1', status });
                mockVersionRepo.getById.mockResolvedValue({ id: 'v1', policyId: 'p1', versionNumber: 1 });
                await expect(
                    usecases.publishPolicy(mockCtx('ADMIN'), 'p1', 'v1')
                ).rejects.toThrow(/cannot publish/i);
            },
        );

        it('allows non-APPROVED publish with bypassApprovalReason + emits POLICY_PUBLISH_BYPASS audit', async () => {
            mockPolicyRepo.getById.mockResolvedValue({ id: 'p1', status: 'DRAFT' });
            mockVersionRepo.getById.mockResolvedValue({ id: 'v1', policyId: 'p1', versionNumber: 1 });
            await expect(
                usecases.publishPolicy(mockCtx('ADMIN'), 'p1', 'v1', {
                    bypassApprovalReason: 'Emergency hot-fix for active incident #IR-42',
                })
            ).resolves.toBeDefined();
            // The bypass audit row fires BEFORE POLICY_PUBLISHED in the same call.
            const actions = (mockLogEvent.mock.calls as any[]).map((c) => c[2].action);
            expect(actions).toContain('POLICY_PUBLISH_BYPASS');
            expect(actions).toContain('POLICY_PUBLISHED');
            const bypassEvent = (mockLogEvent.mock.calls as any[])
                .map((c) => c[2])
                .find((e) => e.action === 'POLICY_PUBLISH_BYPASS');
            expect(bypassEvent.detailsJson.after.bypassReason).toBe(
                'Emergency hot-fix for active incident #IR-42',
            );
            expect(bypassEvent.detailsJson.fromStatus).toBe('DRAFT');
        });

        it('rejects whitespace-only bypassApprovalReason as if missing', async () => {
            mockPolicyRepo.getById.mockResolvedValue({ id: 'p1', status: 'DRAFT' });
            mockVersionRepo.getById.mockResolvedValue({ id: 'v1', policyId: 'p1', versionNumber: 1 });
            await expect(
                usecases.publishPolicy(mockCtx('ADMIN'), 'p1', 'v1', {
                    bypassApprovalReason: '   ',
                })
            ).rejects.toThrow(/cannot publish/i);
        });
    });

    describe('archivePolicy — ADMIN only', () => {
        it('ADMIN can archive', async () => {
            mockPolicyRepo.getById.mockResolvedValue({ id: 'p1' });
            await expect(
                usecases.archivePolicy(mockCtx('ADMIN'), 'p1')
            ).resolves.toEqual({ success: true });
        });

        it.each(['EDITOR', 'READER', 'AUDITOR'])('%s cannot archive', async (role) => {
            await expect(
                usecases.archivePolicy(mockCtx(role), 'p1')
            ).rejects.toThrow(AppError);
        });
    });
});

// ─── Version Numbering ───

describe('Version numbering', () => {
    it('passes correct data to PolicyVersionRepository.create', async () => {
        mockPolicyRepo.getById.mockResolvedValue({ id: 'p1', status: 'DRAFT' });
        mockVersionRepo.create.mockResolvedValue({ id: 'v1', versionNumber: 1 });

        await usecases.createPolicyVersion(
            mockCtx('EDITOR'), 'p1',
            { contentType: 'MARKDOWN', contentText: '# Test', changeSummary: 'Initial' }
        );

        expect(mockVersionRepo.create).toHaveBeenCalledWith(
            mockDb,
            expect.objectContaining({ userId: 'user-1' }),
            'p1',
            { contentType: 'MARKDOWN', contentText: '# Test', changeSummary: 'Initial' }
        );
    });
});

// ─── Archived Policy ───

describe('Archived policy protection', () => {
    it('cannot create a version for an archived policy', async () => {
        mockPolicyRepo.getById.mockResolvedValue({ id: 'p1', status: 'ARCHIVED' });

        await expect(
            usecases.createPolicyVersion(mockCtx('ADMIN'), 'p1', { contentType: 'MARKDOWN', contentText: '# Test' })
        ).rejects.toThrow('Cannot create version for an archived policy');
    });
});

// ─── Status Transitions ───

describe('Status transitions on new version', () => {
    it('moves PUBLISHED policy back to DRAFT on new version', async () => {
        mockPolicyRepo.getById.mockResolvedValue({ id: 'p1', status: 'PUBLISHED' });
        mockVersionRepo.create.mockResolvedValue({ id: 'v2', versionNumber: 2 });

        await usecases.createPolicyVersion(
            mockCtx('EDITOR'), 'p1',
            { contentType: 'MARKDOWN', contentText: '# Updated' }
        );

        expect(mockPolicyRepo.updateStatus).toHaveBeenCalledWith(mockDb, expect.anything(), 'p1', 'DRAFT');
    });
});

// ─── Slug Generation ───

describe('Slug generation', () => {
    it('generates slug from title', async () => {
        mockPolicyRepo.create.mockResolvedValue({ id: 'p1', slug: 'my-test-policy' });

        await usecases.createPolicy(mockCtx('ADMIN'), { title: 'My Test Policy' });

        expect(mockPolicyRepo.create).toHaveBeenCalledWith(
            mockDb,
            expect.anything(),
            expect.objectContaining({ slug: 'my-test-policy' })
        );
    });

    it('deduplicates slug on collision', async () => {
        mockPolicyRepo.getBySlug
            .mockResolvedValueOnce({ id: 'existing' }) // first check: slug exists
            .mockResolvedValueOnce(null);                // second check: slug-1 is free
        mockPolicyRepo.create.mockResolvedValue({ id: 'p2', slug: 'test-1' });

        await usecases.createPolicy(mockCtx('ADMIN'), { title: 'Test' });

        expect(mockPolicyRepo.create).toHaveBeenCalledWith(
            mockDb,
            expect.anything(),
            expect.objectContaining({ slug: 'test-1' })
        );
    });
});

// ─── Template-Based Creation ───

describe('createPolicyFromTemplate', () => {
    it('uses template content and increments version', async () => {
        mockTemplateRepo.getById.mockResolvedValue({
            id: 'tmpl-1',
            title: 'InfoSec Policy',
            category: 'Core',
            contentType: 'MARKDOWN',
            contentText: '# Template Content',
            language: 'en',
        });
        mockPolicyRepo.create.mockResolvedValue({ id: 'p1' });
        mockVersionRepo.create.mockResolvedValue({ id: 'v1', versionNumber: 1 });

        await usecases.createPolicyFromTemplate(mockCtx('EDITOR'), 'tmpl-1', { title: 'Custom Title' });

        expect(mockPolicyRepo.create).toHaveBeenCalledWith(
            mockDb, expect.anything(),
            expect.objectContaining({ title: 'Custom Title', category: 'Core' })
        );
        expect(mockVersionRepo.create).toHaveBeenCalledWith(
            mockDb, expect.anything(), 'p1',
            expect.objectContaining({
                contentType: 'MARKDOWN',
                contentText: '# Template Content',
            })
        );
    });

    it('fails if template not found', async () => {
        mockTemplateRepo.getById.mockResolvedValue(null);
        await expect(
            usecases.createPolicyFromTemplate(mockCtx('EDITOR'), 'nonexistent')
        ).rejects.toThrow('Policy template not found');
    });
});

// ─── Approval Workflow ───

describe('Approval workflow', () => {
    it('approval request moves policy to IN_REVIEW', async () => {
        mockPolicyRepo.getById.mockResolvedValue({ id: 'p1', status: 'DRAFT' });
        mockVersionRepo.getById.mockResolvedValue({ id: 'v1', policyId: 'p1' });
        mockApprovalRepo.request.mockResolvedValue({ id: 'a1' });

        await usecases.requestPolicyApproval(mockCtx('EDITOR'), 'p1', 'v1');

        expect(mockPolicyRepo.updateStatus).toHaveBeenCalledWith(mockDb, expect.anything(), 'p1', 'IN_REVIEW');
    });

    it('rejection moves policy back to DRAFT', async () => {
        mockApprovalRepo.getById.mockResolvedValue({ id: 'a1', policy: { tenantId: 'tenant-1', status: 'IN_REVIEW' }, policyId: 'p1', status: 'PENDING' });
        mockApprovalRepo.decide.mockResolvedValue({ id: 'a1', status: 'REJECTED' });

        await usecases.decidePolicyApproval(mockCtx('ADMIN'), 'p1', 'a1', { decision: 'REJECTED', comment: 'Needs work' });

        expect(mockPolicyRepo.updateStatus).toHaveBeenCalledWith(mockDb, expect.anything(), 'p1', 'DRAFT');
    });

    it('approval sets policy to APPROVED', async () => {
        mockApprovalRepo.getById.mockResolvedValue({ id: 'a1', policy: { tenantId: 'tenant-1', status: 'IN_REVIEW' }, policyId: 'p1', status: 'PENDING' });
        mockApprovalRepo.decide.mockResolvedValue({ id: 'a1', status: 'APPROVED' });

        await usecases.decidePolicyApproval(mockCtx('ADMIN'), 'p1', 'a1', { decision: 'APPROVED' });

        expect(mockPolicyRepo.updateStatus).toHaveBeenCalledWith(mockDb, expect.anything(), 'p1', 'APPROVED');
    });

    it('cannot decide already-decided approval', async () => {
        mockApprovalRepo.getById.mockResolvedValue({ id: 'a1', policy: { tenantId: 'tenant-1', status: 'IN_REVIEW' }, policyId: 'p1', status: 'APPROVED' });

        await expect(
            usecases.decidePolicyApproval(mockCtx('ADMIN'), 'p1', 'a1', { decision: 'REJECTED' })
        ).rejects.toThrow('already been decided');
    });
});
