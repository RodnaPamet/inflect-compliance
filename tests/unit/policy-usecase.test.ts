/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/policy.ts`.
 *
 * Roadmap Q1 — Compliance core. Covers the read paths + the
 * lifecycle write paths. The two heaviest functions (
 * `decidePolicyApproval`, `publishPolicy`) are deferred to a future
 * PR — both span 50+ lines with their own state machines worth
 * dedicated coverage. Same for `createPolicyVersion` which has a
 * separate sanitisation seam.
 *
 * What's covered:
 *   - listPolicies / listPoliciesPaginated / getPolicy /
 *     listPolicyTemplates / getPolicyActivity — read paths + RBAC.
 *   - createPolicy — slug collision loop (slug, slug-1, slug-2),
 *     no-content fast path (no version created), with-content path
 *     (sanitised + version created + setCurrentVersion), audit.
 *   - createPolicyFromTemplate — template notFound, override resolution
 *     (title, category, ownerUserId, language), audit.
 *   - updatePolicyMetadata — nextReviewAt three-state (undefined =
 *     no change, null = clear, string = parsed), audit, notFound.
 *   - archivePolicy — fromStatus/toStatus audit, notFound, admin gate.
 *   - unarchivePolicy — DRAFT landing (not the prior status), the
 *     not-archived conflict, notFound, admin gate.
 *   - deletePolicy / restorePolicy / purgePolicy / listPoliciesWithDeleted —
 *     admin gates + soft-delete delegation.
 */

const mockDb = {
    auditLog: { findMany: jest.fn() },
    policy: { delete: jest.fn(), findMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/PolicyRepository', () => ({
    PolicyRepository: {
        list: jest.fn(),
        listPaginated: jest.fn(),
        ackCountsByVersion: jest.fn(),
        getById: jest.fn(),
        getBySlug: jest.fn(),
        create: jest.fn(),
        setCurrentVersion: jest.fn(),
        updateStatus: jest.fn(),
        updateMetadata: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/PolicyVersionRepository', () => ({
    PolicyVersionRepository: { create: jest.fn() },
}));

jest.mock('@/app-layer/repositories/PolicyApprovalRepository', () => ({
    PolicyApprovalRepository: {},
}));

jest.mock('@/app-layer/repositories/PolicyTemplateRepository', () => ({
    PolicyTemplateRepository: {
        list: jest.fn(),
        getById: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePolicyContent: jest.fn((_type: string, content: string) => `SANITISED::${content}`),
}));

jest.mock('@/app-layer/usecases/soft-delete-operations', () => ({
    restoreEntity: jest.fn(),
    purgeEntity: jest.fn(),
}));

jest.mock('@/lib/soft-delete', () => ({
    withDeleted: jest.fn((args: any) => ({ ...args, _withDeleted: true })),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { PolicyRepository } from '@/app-layer/repositories/PolicyRepository';
import { PolicyVersionRepository } from '@/app-layer/repositories/PolicyVersionRepository';
import { PolicyTemplateRepository } from '@/app-layer/repositories/PolicyTemplateRepository';
import { logEvent } from '@/app-layer/events/audit';
import { sanitizePolicyContent } from '@/lib/security/sanitize';
import { restoreEntity, purgeEntity } from '@/app-layer/usecases/soft-delete-operations';
import {
    listPolicies,
    listPoliciesPaginated,
    getPolicy,
    listPolicyTemplates,
    getPolicyActivity,
    createPolicy,
    createPolicyFromTemplate,
    updatePolicyMetadata,
    archivePolicy,
    unarchivePolicy,
    deletePolicy,
    restorePolicy,
    purgePolicy,
    listPoliciesWithDeleted,
} from '@/app-layer/usecases/policy';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN');
const editorCtx = makeRequestContext('EDITOR');
const readerCtx = makeRequestContext('READER');
const auditorCtx = makeRequestContext('AUDITOR');

// ─── Read paths ────────────────────────────────────────────────────

describe('listPolicies', () => {
    it('delegates to PolicyRepository.list under the read gate', async () => {
        (PolicyRepository.list as jest.Mock).mockResolvedValue([{ id: 'p-1' }]);
        const rows = await listPolicies(readerCtx, { status: 'PUBLISHED' } as any);
        // Rows are annotated with a current-version acknowledgement rollup; a
        // non-PUBLISHED / version-less row annotates to a zero, not-outstanding summary.
        expect(rows).toEqual([{ id: 'p-1', acknowledgement: { assignedCount: 0, acknowledgedCount: 0, outstanding: false } }]);
        expect(PolicyRepository.list).toHaveBeenCalledWith(mockDb, readerCtx, { status: 'PUBLISHED' }, {});
        // No PUBLISHED row with a current version ⇒ no aggregate is issued.
        expect(PolicyRepository.ackCountsByVersion).not.toHaveBeenCalled();
    });

    it('annotates PUBLISHED rows from ONE aggregate keyed by current version', async () => {
        (PolicyRepository.list as jest.Mock).mockResolvedValue([
            { id: 'p-1', status: 'PUBLISHED', currentVersion: { id: 'v-1' } },
            { id: 'p-2', status: 'PUBLISHED', currentVersion: { id: 'v-2' } },
            // DRAFT + version-less rows never carry a live campaign.
            { id: 'p-3', status: 'DRAFT', currentVersion: { id: 'v-3' } },
            { id: 'p-4', status: 'PUBLISHED', currentVersion: null },
        ]);
        (PolicyRepository.ackCountsByVersion as jest.Mock).mockResolvedValue([
            { policyVersionId: 'v-1', assigned: 10, acked: 3 },
            { policyVersionId: 'v-2', assigned: 4, acked: 4 },
        ]);

        const rows = await listPolicies(readerCtx);

        // Exactly one aggregate, scoped to the PUBLISHED current-version ids —
        // v-3 (DRAFT) is excluded so a stale draft campaign can't leak in.
        expect(PolicyRepository.ackCountsByVersion).toHaveBeenCalledTimes(1);
        expect(PolicyRepository.ackCountsByVersion).toHaveBeenCalledWith(
            mockDb,
            readerCtx,
            ['v-1', 'v-2'],
        );
        expect(rows.map((r: any) => r.acknowledgement)).toEqual([
            { assignedCount: 10, acknowledgedCount: 3, outstanding: true },
            { assignedCount: 4, acknowledgedCount: 4, outstanding: false },
            { assignedCount: 0, acknowledgedCount: 0, outstanding: false },
            { assignedCount: 0, acknowledgedCount: 0, outstanding: false },
        ]);
    });

    it('treats a version absent from the aggregate as no campaign', async () => {
        // A PUBLISHED version with zero assignments produces no GROUP BY row.
        // It must annotate to zero/not-outstanding, never to `undefined`.
        (PolicyRepository.list as jest.Mock).mockResolvedValue([
            { id: 'p-1', status: 'PUBLISHED', currentVersion: { id: 'v-1' } },
        ]);
        (PolicyRepository.ackCountsByVersion as jest.Mock).mockResolvedValue([]);

        const rows = await listPolicies(readerCtx);

        expect(rows[0].acknowledgement).toEqual({
            assignedCount: 0,
            acknowledgedCount: 0,
            outstanding: false,
        });
    });

    it('forwards the outstandingAck filter to the repository', async () => {
        (PolicyRepository.list as jest.Mock).mockResolvedValue([]);
        await listPolicies(readerCtx, { outstandingAck: true });
        expect(PolicyRepository.list).toHaveBeenCalledWith(
            mockDb,
            readerCtx,
            { outstandingAck: true },
            {},
        );
    });
});

describe('listPoliciesPaginated', () => {
    it('delegates to PolicyRepository.listPaginated', async () => {
        (PolicyRepository.listPaginated as jest.Mock).mockResolvedValue({ items: [], pageInfo: {} });
        await listPoliciesPaginated(readerCtx, { limit: 25 } as any);
        expect(PolicyRepository.listPaginated).toHaveBeenCalledWith(mockDb, readerCtx, { limit: 25 });
    });
});

describe('getPolicy', () => {
    it('returns the row on hit', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue({ id: 'p-1', title: 'X' });
        const row = await getPolicy(readerCtx, 'p-1');
        expect(row).toEqual({ id: 'p-1', title: 'X' });
    });

    it('throws notFound on miss', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getPolicy(readerCtx, 'missing')).rejects.toThrow(/Policy not found/i);
    });
});

describe('listPolicyTemplates', () => {
    it('delegates to PolicyTemplateRepository.list', async () => {
        (PolicyTemplateRepository.list as jest.Mock).mockResolvedValue([{ id: 't-1' }]);
        const rows = await listPolicyTemplates(readerCtx);
        expect(rows).toEqual([{ id: 't-1' }]);
    });
});

describe('getPolicyActivity', () => {
    it('returns up to 50 audit rows for the policy', async () => {
        (mockDb.auditLog.findMany as jest.Mock).mockResolvedValue([{ id: 'a-1' }]);
        const rows = await getPolicyActivity(readerCtx, 'p-1');
        expect(rows).toEqual([{ id: 'a-1' }]);
        const args = (mockDb.auditLog.findMany as jest.Mock).mock.calls[0][0];
        expect(args.where).toMatchObject({ entity: 'Policy', entityId: 'p-1' });
        expect(args.take).toBe(50);
        expect(args.orderBy).toEqual({ createdAt: 'desc' });
    });
});

// ─── createPolicy ──────────────────────────────────────────────────

describe('createPolicy', () => {
    it('creates a policy with no version when no content supplied', async () => {
        (PolicyRepository.getBySlug as jest.Mock).mockResolvedValue(null);
        (PolicyRepository.create as jest.Mock).mockResolvedValue({ id: 'p-1', title: 'X', slug: 'x' });

        const res = await createPolicy(editorCtx, { title: 'X' });

        expect(res).toEqual({ id: 'p-1', title: 'X', slug: 'x' });
        expect(PolicyVersionRepository.create).not.toHaveBeenCalled();
        expect(PolicyRepository.setCurrentVersion).not.toHaveBeenCalled();
    });

    it('creates a version when content supplied, sanitising before persistence', async () => {
        (PolicyRepository.getBySlug as jest.Mock).mockResolvedValue(null);
        (PolicyRepository.create as jest.Mock).mockResolvedValue({ id: 'p-1', slug: 'x', title: 'X' });
        (PolicyVersionRepository.create as jest.Mock).mockResolvedValue({ id: 'v-1', versionNumber: 1 });

        await createPolicy(editorCtx, { title: 'X', content: '# Hello' });

        expect(sanitizePolicyContent).toHaveBeenCalledWith('MARKDOWN', '# Hello');
        const versionArgs = (PolicyVersionRepository.create as jest.Mock).mock.calls[0][3];
        expect(versionArgs.contentText).toBe('SANITISED::# Hello');
        expect(versionArgs.contentType).toBe('MARKDOWN');
        expect(PolicyRepository.setCurrentVersion).toHaveBeenCalledWith(mockDb, editorCtx, 'p-1', 'v-1');
    });

    it('appends a counter to slug on collision (slug-1, slug-2, …)', async () => {
        (PolicyRepository.getBySlug as jest.Mock)
            .mockResolvedValueOnce({ id: 'p-other' })   // 'x' taken
            .mockResolvedValueOnce({ id: 'p-other2' })  // 'x-1' taken
            .mockResolvedValueOnce(null);               // 'x-2' free
        (PolicyRepository.create as jest.Mock).mockResolvedValue({ id: 'p-1' });

        await createPolicy(editorCtx, { title: 'X' });

        const createArgs = (PolicyRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.slug).toBe('x-2');
    });

    it('falls back to "policy" when title slugifies to empty', async () => {
        (PolicyRepository.getBySlug as jest.Mock).mockResolvedValue(null);
        (PolicyRepository.create as jest.Mock).mockResolvedValue({ id: 'p-1' });

        await createPolicy(editorCtx, { title: '   !!!   ' });

        const createArgs = (PolicyRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.slug).toBe('policy');
    });

    it('emits POLICY_CREATED audit', async () => {
        (PolicyRepository.getBySlug as jest.Mock).mockResolvedValue(null);
        (PolicyRepository.create as jest.Mock).mockResolvedValue({ id: 'p-1', slug: 'x', title: 'X' });

        await createPolicy(editorCtx, { title: 'X' });

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('POLICY_CREATED');
        expect(payload.entityType).toBe('Policy');
    });

    it('rejects READER (write gate)', async () => {
        await expect(createPolicy(readerCtx, { title: 'X' })).rejects.toBeDefined();
        expect(PolicyRepository.getBySlug).not.toHaveBeenCalled();
    });
});

// ─── createPolicyFromTemplate ──────────────────────────────────────

describe('createPolicyFromTemplate', () => {
    it('throws notFound when the template does not exist', async () => {
        (PolicyTemplateRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(createPolicyFromTemplate(editorCtx, 'missing')).rejects.toThrow(/template not found/i);
    });

    it('uses the template title when no override supplied', async () => {
        (PolicyTemplateRepository.getById as jest.Mock).mockResolvedValue({
            id: 't-1', title: 'Tmpl', category: 'CAT', language: 'en', contentType: 'MARKDOWN', contentText: '# T',
        });
        (PolicyRepository.getBySlug as jest.Mock).mockResolvedValue(null);
        (PolicyRepository.create as jest.Mock).mockResolvedValue({ id: 'p-1' });
        (PolicyVersionRepository.create as jest.Mock).mockResolvedValue({ id: 'v-1', versionNumber: 1 });

        await createPolicyFromTemplate(editorCtx, 't-1');

        const createArgs = (PolicyRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.title).toBe('Tmpl');
        expect(createArgs.category).toBe('CAT');
        expect(createArgs.language).toBe('en');
    });

    it('overrides title and category when supplied', async () => {
        (PolicyTemplateRepository.getById as jest.Mock).mockResolvedValue({
            id: 't-1', title: 'Tmpl', category: 'OLD', language: 'en', contentType: 'MARKDOWN', contentText: '# T',
        });
        (PolicyRepository.getBySlug as jest.Mock).mockResolvedValue(null);
        (PolicyRepository.create as jest.Mock).mockResolvedValue({ id: 'p-1' });
        (PolicyVersionRepository.create as jest.Mock).mockResolvedValue({ id: 'v-1', versionNumber: 1 });

        await createPolicyFromTemplate(editorCtx, 't-1', { title: 'Custom', category: 'NEW' });

        const createArgs = (PolicyRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.title).toBe('Custom');
        expect(createArgs.category).toBe('NEW');
    });

    it('rejects READER (write gate)', async () => {
        await expect(createPolicyFromTemplate(readerCtx, 't-1')).rejects.toBeDefined();
        expect(PolicyTemplateRepository.getById).not.toHaveBeenCalled();
    });
});

// ─── updatePolicyMetadata ──────────────────────────────────────────

describe('updatePolicyMetadata', () => {
    it('throws notFound when the policy is missing', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(updatePolicyMetadata(editorCtx, 'missing', { title: 'X' })).rejects.toThrow(/Policy not found/i);
    });

    it('parses a string nextReviewAt into a Date', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue({ id: 'p-1', title: 'X' });

        await updatePolicyMetadata(editorCtx, 'p-1', { nextReviewAt: '2027-06-01T00:00:00Z' });

        const updateArgs = (PolicyRepository.updateMetadata as jest.Mock).mock.calls[0][3];
        expect(updateArgs.nextReviewAt).toEqual(new Date('2027-06-01T00:00:00Z'));
    });

    it('clears nextReviewAt when passed null', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue({ id: 'p-1', title: 'X' });

        await updatePolicyMetadata(editorCtx, 'p-1', { nextReviewAt: null });

        const updateArgs = (PolicyRepository.updateMetadata as jest.Mock).mock.calls[0][3];
        expect(updateArgs.nextReviewAt).toBeNull();
    });

    it('leaves nextReviewAt out of the update when undefined (no change)', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue({ id: 'p-1', title: 'X' });

        await updatePolicyMetadata(editorCtx, 'p-1', { title: 'New title' });

        const updateArgs = (PolicyRepository.updateMetadata as jest.Mock).mock.calls[0][3];
        expect('nextReviewAt' in updateArgs).toBe(false);
    });

    it('emits POLICY_UPDATED audit with changed fields', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue({ id: 'p-1', title: 'X' });

        await updatePolicyMetadata(editorCtx, 'p-1', { title: 'Y', category: 'IT' });

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('POLICY_UPDATED');
        expect(payload.detailsJson.changedFields).toEqual(['title', 'category']);
    });

    it('rejects READER (write gate)', async () => {
        await expect(updatePolicyMetadata(readerCtx, 'p-1', { title: 'X' })).rejects.toBeDefined();
        expect(PolicyRepository.getById).not.toHaveBeenCalled();
    });
});

// ─── archivePolicy ─────────────────────────────────────────────────

describe('archivePolicy', () => {
    it('updates status to ARCHIVED and emits audit with fromStatus/toStatus', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue({ id: 'p-1', title: 'X', status: 'PUBLISHED' });

        const res = await archivePolicy(adminCtx, 'p-1');

        expect(res).toEqual({ success: true });
        expect(PolicyRepository.updateStatus).toHaveBeenCalledWith(mockDb, adminCtx, 'p-1', 'ARCHIVED');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('POLICY_ARCHIVED');
        expect(payload.detailsJson.fromStatus).toBe('PUBLISHED');
        expect(payload.detailsJson.toStatus).toBe('ARCHIVED');
    });

    it('throws notFound when policy missing', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(archivePolicy(adminCtx, 'missing')).rejects.toThrow(/Policy not found/i);
        expect(PolicyRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('rejects EDITOR (admin gate)', async () => {
        await expect(archivePolicy(editorCtx, 'p-1')).rejects.toBeDefined();
        expect(PolicyRepository.getById).not.toHaveBeenCalled();
    });
});

// ─── unarchivePolicy ───────────────────────────────────────────────

describe('unarchivePolicy', () => {
    it('lands in DRAFT and emits audit with fromStatus/toStatus', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue({ id: 'p-1', title: 'X', status: 'ARCHIVED' });

        await unarchivePolicy(adminCtx, 'p-1');

        expect(PolicyRepository.updateStatus).toHaveBeenCalledWith(mockDb, adminCtx, 'p-1', 'DRAFT');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('POLICY_UNARCHIVED');
        expect(payload.detailsJson.fromStatus).toBe('ARCHIVED');
        expect(payload.detailsJson.toStatus).toBe('DRAFT');
    });

    // The load-bearing half of the design: restoring straight to PUBLISHED
    // would put a live document back in front of users — and re-open
    // acknowledgement obligations — without passing the approval gate. A
    // policy archived while PUBLISHED must still come back as a DRAFT.
    it('lands in DRAFT even when the policy was PUBLISHED before archiving', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue({
            id: 'p-1', title: 'X', status: 'ARCHIVED', currentVersionId: 'v-3',
        });

        await unarchivePolicy(adminCtx, 'p-1');

        expect(PolicyRepository.updateStatus).toHaveBeenCalledWith(mockDb, adminCtx, 'p-1', 'DRAFT');
        expect(PolicyRepository.updateStatus).not.toHaveBeenCalledWith(mockDb, adminCtx, 'p-1', 'PUBLISHED');
    });

    it('refuses a policy that is not archived', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue({ id: 'p-1', title: 'X', status: 'PUBLISHED' });

        await expect(unarchivePolicy(adminCtx, 'p-1')).rejects.toThrow(/not archived/i);
        expect(PolicyRepository.updateStatus).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('throws notFound when policy missing', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(unarchivePolicy(adminCtx, 'missing')).rejects.toThrow(/Policy not found/i);
        expect(PolicyRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('rejects EDITOR (admin gate — mirrors archivePolicy)', async () => {
        await expect(unarchivePolicy(editorCtx, 'p-1')).rejects.toBeDefined();
        expect(PolicyRepository.getById).not.toHaveBeenCalled();
    });
});

// ─── deletePolicy / restorePolicy / purgePolicy ────────────────────

describe('deletePolicy', () => {
    it('soft-deletes and emits audit', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue({ id: 'p-1', title: 'X', status: 'DRAFT' });
        (mockDb.policy.delete as jest.Mock).mockResolvedValue({});

        const res = await deletePolicy(adminCtx, 'p-1');

        expect(res).toEqual({ success: true });
        expect(mockDb.policy.delete).toHaveBeenCalledWith({ where: { id: 'p-1' } });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('SOFT_DELETE');
    });

    it('throws notFound when policy missing', async () => {
        (PolicyRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(deletePolicy(adminCtx, 'missing')).rejects.toThrow(/Policy not found/i);
    });

    it('rejects EDITOR (admin gate)', async () => {
        await expect(deletePolicy(editorCtx, 'p-1')).rejects.toBeDefined();
    });
});

describe('restorePolicy', () => {
    it('delegates to restoreEntity', async () => {
        (restoreEntity as jest.Mock).mockResolvedValue({ success: true });
        const res = await restorePolicy(adminCtx, 'p-1');
        expect(res).toEqual({ success: true });
        expect(restoreEntity).toHaveBeenCalledWith(adminCtx, 'Policy', 'p-1');
    });
});

describe('purgePolicy', () => {
    it('delegates to purgeEntity', async () => {
        (purgeEntity as jest.Mock).mockResolvedValue({ success: true });
        const res = await purgePolicy(adminCtx, 'p-1');
        expect(res).toEqual({ success: true });
        expect(purgeEntity).toHaveBeenCalledWith(adminCtx, 'Policy', 'p-1');
    });
});

describe('listPoliciesWithDeleted', () => {
    it('returns soft-deleted rows for ADMIN via withDeleted wrapper', async () => {
        (mockDb.policy.findMany as jest.Mock).mockResolvedValue([{ id: 'p-1' }]);
        const rows = await listPoliciesWithDeleted(adminCtx);
        expect(rows).toEqual([{ id: 'p-1' }]);
        const findManyArgs = (mockDb.policy.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyArgs._withDeleted).toBe(true);
    });

    it('rejects AUDITOR', async () => {
        await expect(listPoliciesWithDeleted(auditorCtx)).rejects.toBeDefined();
    });

    it('rejects READER', async () => {
        await expect(listPoliciesWithDeleted(readerCtx)).rejects.toBeDefined();
    });
});
