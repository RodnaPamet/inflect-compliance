/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/risk.ts`.
 *
 * Roadmap Q2 — Risk. 5-file domain at 60% statements, +20 to Core
 * tier floor. Mocks RiskRepository, RiskTemplateRepository, the
 * scoring helper, sanitizePlainText, createAssignmentNotification,
 * soft-delete delegates, cachedListRead, bumpEntityCacheVersion,
 * and runInTenantContext.
 *
 * Covers:
 *   - List paths with owner enrichment (the Epic 44.4 batch-attach
 *     `owner` from the User table) — includes the zero-id fast
 *     path.
 *   - getRisk happy + notFound.
 *   - createRisk — score computation via calculateRiskScore using
 *     tenant.maxRiskScale (fallback 5), defaults for impact/
 *     likelihood (3), Epic D.2 sanitisation across every free-text
 *     column.
 *   - createRiskFromTemplate — notFound on template, override
 *     resolution + override-takes-precedence merge.
 *   - updateRisk — three-state sanitiseOptional contract for
 *     description/category/treatmentOwner/treatmentNotes; threat/
 *     vulnerability with `?? undefined` fallback so empty-string
 *     doesn't write; ownerUserId three-state ('' or null → clear);
 *     in-app RISK_ASSIGNED notification ONLY on owner change to a
 *     real user; fire-and-forget notification error swallow.
 *   - deleteRisk — admin gate + audit + notFound.
 *   - restore/purge/listWithDeleted — delegation + admin gate.
 *   - linkControlToRisk — double cache bump (risk + control).
 */

const mockDb = {
    tenant: { findUnique: jest.fn() },
    user: { findMany: jest.fn() },
    risk: { findFirst: jest.fn(), findMany: jest.fn() },
    // create/updateRisk + bulkAssignRisk verify a supplied ownerUserId is an
    // ACTIVE member of the tenant before writing it (the FK points at the
    // GLOBAL User table, so the DB alone can't enforce tenancy). Default the
    // membership lookup to a hit so owner-bearing writes proceed.
    tenantMembership: { findFirst: jest.fn().mockResolvedValue({ userId: 'u-owner' }) },
    // B7 — listRisks now folds in TaskRepository.countLinkedToEntities
    // (TaskLink count). Default to no links → taskTotal/taskDone = 0.
    taskLink: { findMany: jest.fn().mockResolvedValue([]) },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(async (opts: any) => opts.loader()),
    bumpEntityCacheVersion: jest.fn(),
}));

jest.mock('@/app-layer/repositories/RiskRepository', () => ({
    RiskRepository: {
        list: jest.fn(),
        listPaginated: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        linkControl: jest.fn(),
        // Bulk-assign path (owner-tenancy validation suite).
        listByIds: jest.fn(),
        bulkUpdate: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/RiskTemplateRepository', () => ({
    RiskTemplateRepository: {
        getById: jest.fn(),
    },
}));

// RQ2-1 — create/update/template paths now append provenance ledger
// entries inside the same transaction. Mock the seam; the dedicated
// suite (risk-score-events.test.ts) covers its behavior.
jest.mock('@/app-layer/usecases/risk-score-events', () => ({
    recordScoreEvent: jest.fn(),
}));

jest.mock('@/lib/risk-scoring', () => ({
    calculateRiskScore: jest.fn((l: number, i: number, m: number) => l * i * (m / 5)),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SAN::${s}`),
}));

jest.mock('@/app-layer/notifications/assignment', () => ({
    createAssignmentNotification: jest.fn(),
}));

jest.mock('@/app-layer/usecases/soft-delete-operations', () => ({
    restoreEntity: jest.fn(),
    purgeEntity: jest.fn(),
}));

jest.mock('@/lib/soft-delete', () => ({
    withDeleted: jest.fn((args: any) => ({ ...args, _withDeleted: true })),
}));

jest.mock('@/lib/observability', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { RiskRepository } from '@/app-layer/repositories/RiskRepository';
import { RiskTemplateRepository } from '@/app-layer/repositories/RiskTemplateRepository';
import { logEvent } from '@/app-layer/events/audit';
import { calculateRiskScore } from '@/lib/risk-scoring';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { createAssignmentNotification } from '@/app-layer/notifications/assignment';
import { restoreEntity, purgeEntity } from '@/app-layer/usecases/soft-delete-operations';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import {
    listRisks,
    listRisksPaginated,
    getRisk,
    createRisk,
    createRiskFromTemplate,
    updateRisk,
    deleteRisk,
    restoreRisk,
    purgeRisk,
    listRisksWithDeleted,
    linkControlToRisk,
    bulkAssignRisk,
} from '@/app-layer/usecases/risk';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
    (sanitizePlainText as jest.Mock).mockImplementation((s: string) => `SAN::${s}`);
});

const adminCtx = makeRequestContext('ADMIN', { tenantSlug: 'acme' });
const editorCtx = makeRequestContext('EDITOR', { tenantSlug: 'acme' });
const readerCtx = makeRequestContext('READER', { tenantSlug: 'acme' });
const auditorCtx = makeRequestContext('AUDITOR');

// ─── List paths — owner enrichment ─────────────────────────────────

describe('listRisks — owner enrichment', () => {
    it('attaches `owner: null` to every row when no rows have ownerUserId (zero-id fast path)', async () => {
        (RiskRepository.list as jest.Mock).mockResolvedValue([
            { id: 'r-1', ownerUserId: null },
            { id: 'r-2', ownerUserId: null },
        ]);

        const rows = await listRisks(readerCtx);

        // B7 — listRisks folds in linked-task counts (0/0 with no links).
        expect(rows).toEqual([
            { id: 'r-1', ownerUserId: null, owner: null, taskTotal: 0, taskDone: 0 },
            { id: 'r-2', ownerUserId: null, owner: null, taskTotal: 0, taskDone: 0 },
        ]);
        // Zero-id fast path — User lookup never fires.
        expect(mockDb.user.findMany).not.toHaveBeenCalled();
    });

    it('batches the User lookup and matches each row to its owner', async () => {
        (RiskRepository.list as jest.Mock).mockResolvedValue([
            { id: 'r-1', ownerUserId: 'u-1' },
            { id: 'r-2', ownerUserId: 'u-2' },
            { id: 'r-3', ownerUserId: null },
        ]);
        (mockDb.user.findMany as jest.Mock).mockResolvedValue([
            { id: 'u-1', name: 'Alice', email: 'a@e' },
            { id: 'u-2', name: 'Bob', email: 'b@e' },
        ]);

        // The Risk row's TS type comes from RiskRepository.list and
        // doesn't carry `owner` — that field is attached at the usecase
        // layer by `attachOwnerUsers`. Cast to `any[]` here so the
        // structural assertions read the enriched shape without
        // fighting the source-of-truth repository type.
        const rows = (await listRisks(readerCtx)) as any[];

        expect(rows[0].owner).toEqual({ id: 'u-1', name: 'Alice', email: 'a@e' });
        expect(rows[1].owner).toEqual({ id: 'u-2', name: 'Bob', email: 'b@e' });
        expect(rows[2].owner).toBeNull();
        // One batched query, not per-row.
        expect(mockDb.user.findMany).toHaveBeenCalledTimes(1);
        const findManyArgs = (mockDb.user.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyArgs.where.id.in.sort()).toEqual(['u-1', 'u-2']);
    });

    it('handles users that disappeared between the risk list and lookup (orphan ownerUserId → null)', async () => {
        (RiskRepository.list as jest.Mock).mockResolvedValue([
            { id: 'r-1', ownerUserId: 'u-ghost' },
        ]);
        (mockDb.user.findMany as jest.Mock).mockResolvedValue([]);
        const rows = (await listRisks(readerCtx)) as any[];
        expect(rows[0].owner).toBeNull();
    });

    it('puts `take` into the cache key when supplied', async () => {
        (RiskRepository.list as jest.Mock).mockResolvedValue([]);
        await listRisks(readerCtx, { status: 'OPEN' } as any, { take: 10 });
        const { cachedListRead } = await import('@/lib/cache/list-cache');
        const args = (cachedListRead as jest.Mock).mock.calls[0][0];
        expect(args.params).toEqual({ status: 'OPEN', _take: 10 });
    });
});

describe('listRisksPaginated — owner enrichment + pagination shape', () => {
    it('enriches owners and preserves the pageInfo wrapper', async () => {
        (RiskRepository.listPaginated as jest.Mock).mockResolvedValue({
            items: [{ id: 'r-1', ownerUserId: 'u-1' }],
            pageInfo: { hasNextPage: false, nextCursor: null },
        });
        (mockDb.user.findMany as jest.Mock).mockResolvedValue([{ id: 'u-1', name: 'Alice', email: 'a@e' }]);

        // Same `owner` enrichment cast as in listRisks above —
        // RiskRepository.listPaginated's items[] doesn't carry `owner`
        // in its source type.
        const res = (await listRisksPaginated(readerCtx, {} as any)) as any;

        expect(res.pageInfo).toEqual({ hasNextPage: false, nextCursor: null });
        expect(res.items[0].owner).toEqual({ id: 'u-1', name: 'Alice', email: 'a@e' });
    });
});

// ─── getRisk ───────────────────────────────────────────────────────

describe('getRisk', () => {
    it('returns the risk on hit', async () => {
        (RiskRepository.getById as jest.Mock).mockResolvedValue({ id: 'r-1' });
        await expect(getRisk(readerCtx, 'r-1')).resolves.toEqual({ id: 'r-1' });
    });

    it('throws notFound on miss', async () => {
        (RiskRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getRisk(readerCtx, 'missing')).rejects.toThrow(/Risk not found/i);
    });
});

// ─── createRisk ────────────────────────────────────────────────────

describe('createRisk', () => {
    it('uses tenant.maxRiskScale for the score, defaulting to 5', async () => {
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: null });
        (RiskRepository.create as jest.Mock).mockResolvedValue({ id: 'r-1', title: 'X' });

        await createRisk(editorCtx, { title: 'X', impact: 4, likelihood: 2 });

        expect(calculateRiskScore).toHaveBeenCalledWith(2, 4, 5); // default scale = 5
        const createArgs = (RiskRepository.create as jest.Mock).mock.calls[0][2];
        // mock formula: l*i*(m/5) = 2*4*1 = 8
        expect(createArgs.inherentScore).toBe(8);
    });

    it('defaults impact/likelihood to 3 each when not supplied', async () => {
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 10 });
        (RiskRepository.create as jest.Mock).mockResolvedValue({ id: 'r-1', title: 'X' });

        await createRisk(editorCtx, { title: 'X' });

        expect(calculateRiskScore).toHaveBeenCalledWith(3, 3, 10);
    });

    it('sanitises every free-text column', async () => {
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });
        (RiskRepository.create as jest.Mock).mockResolvedValue({ id: 'r-1', title: 'X' });

        await createRisk(editorCtx, {
            title: 'Risk title',
            description: 'Risk desc',
            category: 'Privacy',
            threat: 'Phishing',
            vulnerability: 'No 2FA',
            treatmentOwner: 'sec-team',
            treatmentNotes: 'Pending vendor',
        });

        const createArgs = (RiskRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.title).toBe('SAN::Risk title');
        expect(createArgs.description).toBe('SAN::Risk desc');
        expect(createArgs.category).toBe('SAN::Privacy');
        expect(createArgs.threat).toBe('SAN::Phishing');
        expect(createArgs.vulnerability).toBe('SAN::No 2FA');
        expect(createArgs.treatmentOwner).toBe('SAN::sec-team');
        expect(createArgs.treatmentNotes).toBe('SAN::Pending vendor');
    });

    it('rejects READER (write gate)', async () => {
        await expect(createRisk(readerCtx, { title: 'X' })).rejects.toBeDefined();
    });
});

// ─── createRiskFromTemplate ────────────────────────────────────────

describe('createRiskFromTemplate', () => {
    it('throws notFound when the template is missing', async () => {
        (RiskTemplateRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(createRiskFromTemplate(editorCtx, 'missing')).rejects.toThrow(/template not found/i);
    });

    it('uses template defaults for missing override fields', async () => {
        (RiskTemplateRepository.getById as jest.Mock).mockResolvedValue({
            id: 't-1', title: 'Tmpl', description: 'Tmpl desc', category: 'OPS',
            defaultLikelihood: 4, defaultImpact: 3,
        });
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });
        (RiskRepository.create as jest.Mock).mockResolvedValue({ id: 'r-1', title: 'SAN::Tmpl' });

        await createRiskFromTemplate(editorCtx, 't-1');

        const createArgs = (RiskRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.title).toBe('SAN::Tmpl');
        expect(createArgs.likelihood).toBe(4);
        expect(createArgs.impact).toBe(3);
    });

    it('overrides take precedence over template values', async () => {
        (RiskTemplateRepository.getById as jest.Mock).mockResolvedValue({
            id: 't-1', title: 'Tmpl', description: null, category: 'OPS',
            defaultLikelihood: 4, defaultImpact: 3,
        });
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });
        (RiskRepository.create as jest.Mock).mockResolvedValue({ id: 'r-1' });

        await createRiskFromTemplate(editorCtx, 't-1', { title: 'Custom', impact: 5, likelihood: 5 });

        const createArgs = (RiskRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.title).toBe('SAN::Custom');
        expect(createArgs.likelihood).toBe(5);
        expect(createArgs.impact).toBe(5);
    });
});

// ─── updateRisk — three-state contract + notification ──────────────

describe('updateRisk — three-state field semantics', () => {
    it('passes undefined through for fields not in the patch', async () => {
        (RiskRepository.getById as jest.Mock).mockResolvedValue({ id: 'r-1', ownerUserId: 'u-prev' });
        (RiskRepository.update as jest.Mock).mockResolvedValue({ id: 'r-1', ownerUserId: 'u-prev' });
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });

        await updateRisk(editorCtx, 'r-1', { title: 'New' });

        const updateArgs = (RiskRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.description).toBeUndefined();
        expect(updateArgs.category).toBeUndefined();
        expect(updateArgs.ownerUserId).toBeUndefined();
    });

    it('clears free-text when null supplied (SET NULL)', async () => {
        (RiskRepository.getById as jest.Mock).mockResolvedValue({ id: 'r-1', ownerUserId: 'u-prev' });
        (RiskRepository.update as jest.Mock).mockResolvedValue({ id: 'r-1', ownerUserId: 'u-prev' });
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });

        await updateRisk(editorCtx, 'r-1', { description: null, category: null });

        const updateArgs = (RiskRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.description).toBeNull();
        expect(updateArgs.category).toBeNull();
    });

    it('clears ownerUserId when empty string supplied (treated as falsy)', async () => {
        (RiskRepository.getById as jest.Mock).mockResolvedValue({ id: 'r-1', ownerUserId: 'u-prev' });
        (RiskRepository.update as jest.Mock).mockResolvedValue({ id: 'r-1', ownerUserId: null });
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });

        await updateRisk(editorCtx, 'r-1', { ownerUserId: '' });

        const updateArgs = (RiskRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.ownerUserId).toBeNull();
    });

    it('throws notFound when the risk does not exist', async () => {
        (RiskRepository.getById as jest.Mock).mockResolvedValue(null);
        (RiskRepository.update as jest.Mock).mockResolvedValue(null);
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });
        await expect(updateRisk(editorCtx, 'missing', { title: 'X' })).rejects.toThrow(/Risk not found/i);
    });
});

describe('updateRisk — RISK_ASSIGNED notification', () => {
    it('fires the notification only on owner change to a real user', async () => {
        (RiskRepository.getById as jest.Mock).mockResolvedValue({ id: 'r-1', ownerUserId: 'u-prev' });
        (RiskRepository.update as jest.Mock).mockResolvedValue({ id: 'r-1', title: 'X', key: 'RISK-1', ownerUserId: 'u-new' });
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });

        await updateRisk(editorCtx, 'r-1', { ownerUserId: 'u-new' });

        expect(createAssignmentNotification).toHaveBeenCalledTimes(1);
        const args = (createAssignmentNotification as jest.Mock).mock.calls[0];
        expect(args[1]).toBe('RISK_ASSIGNED');
        expect(args[2]).toMatchObject({ assigneeUserId: 'u-new', entityId: 'r-1' });
    });

    it('does NOT fire when owner is unchanged', async () => {
        (RiskRepository.getById as jest.Mock).mockResolvedValue({ id: 'r-1', ownerUserId: 'u-same' });
        (RiskRepository.update as jest.Mock).mockResolvedValue({ id: 'r-1', title: 'X', ownerUserId: 'u-same' });
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });

        await updateRisk(editorCtx, 'r-1', { title: 'New' });

        expect(createAssignmentNotification).not.toHaveBeenCalled();
    });

    it('does NOT fire when owner is cleared (no new assignee)', async () => {
        (RiskRepository.getById as jest.Mock).mockResolvedValue({ id: 'r-1', ownerUserId: 'u-prev' });
        (RiskRepository.update as jest.Mock).mockResolvedValue({ id: 'r-1', title: 'X', ownerUserId: null });
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });

        await updateRisk(editorCtx, 'r-1', { ownerUserId: null });

        expect(createAssignmentNotification).not.toHaveBeenCalled();
    });

    it('does not surface notification errors (fire-and-forget)', async () => {
        (RiskRepository.getById as jest.Mock).mockResolvedValue({ id: 'r-1', ownerUserId: null });
        (RiskRepository.update as jest.Mock).mockResolvedValue({ id: 'r-1', title: 'X', ownerUserId: 'u-new' });
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });
        (createAssignmentNotification as jest.Mock).mockRejectedValue(new Error('Redis down'));

        await expect(updateRisk(editorCtx, 'r-1', { ownerUserId: 'u-new' })).resolves.toMatchObject({ id: 'r-1' });
    });
});

// ─── deleteRisk / restoreRisk / purgeRisk / listRisksWithDeleted ───

describe('deleteRisk', () => {
    it('returns success and emits SOFT_DELETE audit for ADMIN', async () => {
        (RiskRepository.delete as jest.Mock).mockResolvedValue({ id: 'r-1' });
        const res = await deleteRisk(adminCtx, 'r-1');
        expect(res).toEqual({ success: true });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('SOFT_DELETE');
    });

    it('throws notFound when missing', async () => {
        (RiskRepository.delete as jest.Mock).mockResolvedValue(null);
        await expect(deleteRisk(adminCtx, 'missing')).rejects.toThrow(/Risk not found/i);
    });

    it('rejects EDITOR (admin gate)', async () => {
        await expect(deleteRisk(editorCtx, 'r-1')).rejects.toBeDefined();
    });
});

describe('restoreRisk', () => {
    it('delegates to restoreEntity', async () => {
        (restoreEntity as jest.Mock).mockResolvedValue({ success: true });
        await restoreRisk(adminCtx, 'r-1');
        expect(restoreEntity).toHaveBeenCalledWith(adminCtx, 'Risk', 'r-1');
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(adminCtx, 'risk');
    });
});

describe('purgeRisk', () => {
    it('delegates to purgeEntity', async () => {
        (purgeEntity as jest.Mock).mockResolvedValue({ success: true });
        await purgeRisk(adminCtx, 'r-1');
        expect(purgeEntity).toHaveBeenCalledWith(adminCtx, 'Risk', 'r-1');
    });
});

describe('listRisksWithDeleted', () => {
    it('admin-gated and uses the withDeleted wrapper', async () => {
        (mockDb.risk.findMany as jest.Mock).mockResolvedValue([{ id: 'r-1' }]);
        await listRisksWithDeleted(adminCtx);
        const args = (mockDb.risk.findMany as jest.Mock).mock.calls[0][0];
        expect(args._withDeleted).toBe(true);
    });

    it('rejects AUDITOR', async () => {
        await expect(listRisksWithDeleted(auditorCtx)).rejects.toBeDefined();
    });

    it('rejects READER', async () => {
        await expect(listRisksWithDeleted(readerCtx)).rejects.toBeDefined();
    });
});

// ─── linkControlToRisk ─────────────────────────────────────────────

describe('linkControlToRisk', () => {
    it('bumps BOTH risk and control caches on success', async () => {
        (RiskRepository.linkControl as jest.Mock).mockResolvedValue({ id: 'rc-1' });
        await linkControlToRisk(editorCtx, 'r-1', 'c-1');
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(editorCtx, 'risk');
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(editorCtx, 'control');
    });

    it('throws notFound when the risk does not exist', async () => {
        (RiskRepository.linkControl as jest.Mock).mockResolvedValue(null);
        await expect(linkControlToRisk(editorCtx, 'missing', 'c-1')).rejects.toThrow(/Risk not found/i);
    });

    it('rejects READER', async () => {
        await expect(linkControlToRisk(readerCtx, 'r-1', 'c-1')).rejects.toBeDefined();
    });
});


// ─── Owner (assignee) tenancy validation ───────────────────────────
//
// `Risk.ownerUserId` is an FK to the GLOBAL `User` table, so the database
// accepts ANY existing user id — including one belonging to another tenant.
// Every path that takes an owner straight off the request body must check
// tenant membership itself.

describe('assignee validation — ownerUserId must be an ACTIVE tenant member', () => {
    beforeEach(() => {
        (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ maxRiskScale: 5 });
        (RiskRepository.create as jest.Mock).mockResolvedValue({ id: 'r-new', title: 'T' });
        (RiskRepository.getById as jest.Mock).mockResolvedValue({ id: 'r-1', ownerUserId: null });
        (RiskRepository.update as jest.Mock).mockResolvedValue({ id: 'r-1' });
        (RiskRepository.listByIds as jest.Mock)?.mockResolvedValue?.([{ id: 'r-1' }]);
    });

    it('createRisk rejects an owner who is not a member of the tenant', async () => {
        (mockDb.tenantMembership.findFirst as jest.Mock).mockResolvedValueOnce(null);
        await expect(
            createRisk(editorCtx, { title: 'X', ownerUserId: 'u-foreign' }),
        ).rejects.toThrow(/active member/i);
        expect(RiskRepository.create).not.toHaveBeenCalled();
    });

    it('createRisk accepts an owner who IS an active member', async () => {
        (mockDb.tenantMembership.findFirst as jest.Mock).mockResolvedValueOnce({ userId: 'u-ok' });
        await createRisk(editorCtx, { title: 'X', ownerUserId: 'u-ok' });
        expect(RiskRepository.create).toHaveBeenCalled();
    });

    it('createRisk skips the lookup entirely when no owner is supplied', async () => {
        await createRisk(editorCtx, { title: 'X' });
        expect(mockDb.tenantMembership.findFirst).not.toHaveBeenCalled();
        expect(RiskRepository.create).toHaveBeenCalled();
    });

    it('updateRisk rejects a foreign owner', async () => {
        (mockDb.tenantMembership.findFirst as jest.Mock).mockResolvedValueOnce(null);
        await expect(
            updateRisk(editorCtx, 'r-1', { ownerUserId: 'u-foreign' }),
        ).rejects.toThrow(/active member/i);
        expect(RiskRepository.update).not.toHaveBeenCalled();
    });

    it('updateRisk allows CLEARING the owner without a membership lookup', async () => {
        await updateRisk(editorCtx, 'r-1', { ownerUserId: '' });
        expect(mockDb.tenantMembership.findFirst).not.toHaveBeenCalled();
        expect(RiskRepository.update).toHaveBeenCalled();
    });

    it('bulkAssignRisk rejects a foreign owner before touching any row', async () => {
        (mockDb.tenantMembership.findFirst as jest.Mock).mockResolvedValueOnce(null);
        await expect(
            bulkAssignRisk(editorCtx, ['r-1', 'r-2'], 'u-foreign'),
        ).rejects.toThrow(/active member/i);
        expect(RiskRepository.bulkUpdate).not.toHaveBeenCalled();
    });
});
