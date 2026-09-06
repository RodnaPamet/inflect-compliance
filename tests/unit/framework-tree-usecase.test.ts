/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Wave-C coverage — framework tree usecase (previously 0% branches).
 *
 * `getFrameworkTree` (version-resolution + not-found + tree assembly) and
 * `reorderFrameworkRequirements` (unknown-id / duplicate-id / partial-
 * overlay rejections + the happy-path upsert). Prisma, the tenant context,
 * and the audit emitter are mocked; the pure framework-tree libs
 * (build / compliance / reorder) run for real.
 */

const tctx: { db: any } = { db: null };

jest.mock('@/lib/prisma', () => ({
    prisma: {
        framework: { findUnique: jest.fn(), findFirst: jest.fn() },
        frameworkRequirement: { findMany: jest.fn() },
    },
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(tctx.db)),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import { prisma } from '@/lib/prisma';
import { logEvent } from '@/app-layer/events/audit';
import {
    getFrameworkTree,
    reorderFrameworkRequirements,
} from '@/app-layer/usecases/framework/tree';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');
const p = prisma as any;

const FW = { id: 'fw1', key: 'ISO27001', name: 'ISO 27001', version: '2022', kind: 'STANDARD', description: null };
const REQS = [
    { id: 'r1', code: 'A.5.1', title: 'Policies', description: null, section: 'A.5', category: null, theme: null, themeNumber: null, sortOrder: 0 },
    { id: 'r2', code: 'A.5.2', title: 'Roles', description: null, section: 'A.5', category: null, theme: null, themeNumber: null, sortOrder: 1 },
];

beforeEach(() => {
    jest.clearAllMocks();
    tctx.db = {
        frameworkRequirementOrder: {
            findMany: jest.fn().mockResolvedValue([]),
            upsert: jest.fn().mockImplementation(({ create }: any) => Promise.resolve({ id: `ord-${create.requirementId}` })),
        },
        controlRequirementLink: { findMany: jest.fn().mockResolvedValue([]) },
        // A framework can exist twice in `Framework` under two keys, so the
        // links query is widened to the whole family first
        // (`services/framework-representation-aliases.ts`). Both reads are
        // GLOBAL-table reads made inside the SAME tenant transaction as the
        // links query, which is why they are mocked here and not on the
        // module-level `prisma` mock above. Empty: this suite is about tree
        // assembly, and the DB-backed proof that the collapse works lives in
        // `tests/integration/framework-representation-coverage.test.ts`.
        framework: { findMany: jest.fn().mockResolvedValue([]) },
        frameworkRequirement: { findMany: jest.fn().mockResolvedValue([]) },
    };
});

describe('getFrameworkTree', () => {
    it('resolves a versioned framework, assembles a tree, and returns nodes', async () => {
        p.framework.findUnique.mockResolvedValue(FW);
        p.frameworkRequirement.findMany.mockResolvedValue(REQS);
        const tree = await getFrameworkTree(ctx, 'ISO27001', '2022');
        // Branch: version present → findUnique.
        expect(p.framework.findUnique).toHaveBeenCalled();
        expect(tree.framework.key).toBe('ISO27001');
        expect(Array.isArray(tree.nodes)).toBe(true);
        expect(tree.nodes.length).toBeGreaterThan(0);
    });

    it('falls back to findFirst when no version and decorates with linked controls', async () => {
        p.framework.findFirst.mockResolvedValue(FW);
        p.frameworkRequirement.findMany.mockResolvedValue(REQS);
        // Branch: reqIds.length > 0 → links query returns a control for r1.
        tctx.db.controlRequirementLink.findMany.mockResolvedValue([
            { requirementId: 'r1', control: { id: 'c1', status: 'IMPLEMENTED', applicability: 'APPLICABLE' } },
        ]);
        const tree = await getFrameworkTree(ctx, 'ISO27001');
        expect(p.framework.findFirst).toHaveBeenCalled();
        expect(tree.nodes.length).toBeGreaterThan(0);
    });

    it('returns an empty-requirements tree without querying overlay/links', async () => {
        p.framework.findFirst.mockResolvedValue(FW);
        p.frameworkRequirement.findMany.mockResolvedValue([]);
        const tree = await getFrameworkTree(ctx, 'ISO27001');
        // Branch: requirementsRaw.length === 0 → overlay skipped; reqIds.length === 0 → links skipped.
        expect(tctx.db.frameworkRequirementOrder.findMany).not.toHaveBeenCalled();
        expect(tctx.db.controlRequirementLink.findMany).not.toHaveBeenCalled();
        expect(tree.framework.key).toBe('ISO27001');
        expect(tree.nodes.length).toBe(0);
    });

    it('throws notFound when the framework is missing', async () => {
        p.framework.findFirst.mockResolvedValue(null);
        await expect(getFrameworkTree(ctx, 'NOPE')).rejects.toThrow('Framework not found');
    });
});

describe('reorderFrameworkRequirements', () => {
    beforeEach(() => {
        p.framework.findFirst.mockResolvedValue(FW);
        p.frameworkRequirement.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    });

    it('throws notFound when the framework is missing', async () => {
        p.framework.findFirst.mockResolvedValueOnce(null);
        await expect(
            reorderFrameworkRequirements(ctx, 'NOPE', [{ sectionId: 's', requirementIds: ['r1'] }]),
        ).rejects.toThrow('Framework not found');
    });

    it('rejects unknown requirement ids', async () => {
        // Branch: findUnknownRequirementIds → unknown.length > 0.
        await expect(
            reorderFrameworkRequirements(ctx, 'ISO27001', [{ sectionId: 's', requirementIds: ['rX'] }]),
        ).rejects.toThrow('unknown requirement id');
    });

    it('rejects duplicate requirement ids', async () => {
        // Branch: seen.has(id) duplicate guard.
        await expect(
            reorderFrameworkRequirements(ctx, 'ISO27001', [{ sectionId: 's', requirementIds: ['r1', 'r1'] }]),
        ).rejects.toThrow('Duplicate requirement id');
    });

    it('rejects partial overlays (count mismatch)', async () => {
        // Branch: total !== liveIds.size.
        await expect(
            reorderFrameworkRequirements(ctx, 'ISO27001', [{ sectionId: 's', requirementIds: ['r1'] }]),
        ).rejects.toThrow('partial reorders are not supported');
    });

    it('persists a full overlay, audits, and returns the updated count', async () => {
        const r = await reorderFrameworkRequirements(ctx, 'ISO27001', [
            { sectionId: 's1', requirementIds: ['r1', 'r2'] },
        ]);
        // Branch: happy path → one upsert per requirement + audit.
        expect(tctx.db.frameworkRequirementOrder.upsert).toHaveBeenCalledTimes(2);
        expect(r).toEqual({ updated: 2 });
        expect((logEvent as jest.Mock).mock.calls[0][2].action).toBe('FRAMEWORK_REORDERED');
    });
});
