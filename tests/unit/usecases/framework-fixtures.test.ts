/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for `src/app-layer/usecases/framework/fixtures.ts`.
 *
 * Wave-10 / stage-3h branch coverage. The module's one export (its
 * requirement writer, `upsertRequirements`, was removed in the #4125
 * follow-up: framework requirements are a global catalogue no workspace
 * may rewrite):
 *
 *   - `computeRequirementsDiff` — produces added / removed / changed
 *     sets + unmapped-new-requirements count. Branches:
 *       • policy gate (assertCanViewFrameworks)
 *       • from-framework not found
 *       • to-framework not found
 *       • added (in to, not in from)
 *       • removed (in from, not in to)
 *       • changed — title / section / description differs
 *       • section fallback to category when section is null
 *       • unmappedNewRequirements > 0 path (calls
 *         runInTenantContext + controlRequirementLink.findMany)
 *       • added.length === 0 → mapping check skipped
 */

const policyCalls: string[] = [];

jest.mock('@/app-layer/policies/framework.policies', () => ({
    assertCanViewFrameworks: jest.fn(() => policyCalls.push('view')),
}));

const prismaMock: any = {
    framework: { findFirst: jest.fn() },
    frameworkRequirement: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
    },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: prismaMock,
    prisma: prismaMock,
}));

const tenantDb: any = {
    controlRequirementLink: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, cb: any) => cb(tenantDb)),
    };
});

import { computeRequirementsDiff } from '@/app-layer/usecases/framework/fixtures';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    prismaMock.framework.findFirst.mockReset();
    prismaMock.frameworkRequirement.findUnique.mockReset();
    prismaMock.frameworkRequirement.create.mockReset();
    prismaMock.frameworkRequirement.update.mockReset();
    prismaMock.frameworkRequirement.updateMany.mockReset();
    prismaMock.frameworkRequirement.findMany.mockReset();
    tenantDb.controlRequirementLink.findMany.mockReset();
});

const ctx = makeRequestContext('ADMIN');

describe('computeRequirementsDiff — guard rails', () => {
    it('invokes assertCanViewFrameworks (read-only diff)', async () => {
        prismaMock.framework.findFirst
            .mockResolvedValueOnce({ id: 'fw-from', key: 'iso-2013', name: 'ISO', version: '2013' })
            .mockResolvedValueOnce({ id: 'fw-to', key: 'iso-2022', name: 'ISO', version: '2022' });
        prismaMock.frameworkRequirement.findMany.mockResolvedValue([]);
        await computeRequirementsDiff(ctx, 'iso-2013', 'iso-2022');
        expect(policyCalls[0]).toBe('view');
    });

    it('throws notFound when the FROM framework is missing', async () => {
        prismaMock.framework.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'fw-to' });
        await expect(
            computeRequirementsDiff(ctx, 'gone', 'iso'),
        ).rejects.toMatchObject({ message: expect.stringMatching(/Framework "gone" not found/), details: { reason: 'DIFF_FROM_NOT_FOUND' } });
    });

    it('throws notFound when the TO framework is missing', async () => {
        prismaMock.framework.findFirst
            .mockResolvedValueOnce({ id: 'fw-from' })
            .mockResolvedValueOnce(null);
        await expect(
            computeRequirementsDiff(ctx, 'iso', 'gone'),
        ).rejects.toMatchObject({ message: expect.stringMatching(/Framework "gone" not found/), details: { reason: 'DIFF_TO_NOT_FOUND' } });
    });
});

describe('computeRequirementsDiff — diff computation', () => {
    function setupFrameworks() {
        prismaMock.framework.findFirst
            .mockResolvedValueOnce({ id: 'fw-from', key: 'iso-2013', name: 'ISO', version: '2013' })
            .mockResolvedValueOnce({ id: 'fw-to', key: 'iso-2022', name: 'ISO', version: '2022' });
    }

    it('identifies added / removed / changed (title) — section falls back to category', async () => {
        setupFrameworks();
        prismaMock.frameworkRequirement.findMany
            // FROM
            .mockResolvedValueOnce([
                { id: 'rf-1', code: 'A.1', title: 'Old', section: null, category: 'Cat-A', description: 'd1' },
                { id: 'rf-2', code: 'A.2', title: 'Removed', section: 'S1', category: null, description: 'd2' },
                { id: 'rf-3', code: 'A.3', title: 'Same', section: 'S3', category: null, description: 'd3' },
            ])
            // TO
            .mockResolvedValueOnce([
                { id: 'rt-1', code: 'A.1', title: 'New', section: null, category: 'Cat-A', description: 'd1' },
                { id: 'rt-3', code: 'A.3', title: 'Same', section: 'S3', category: null, description: 'd3' },
                { id: 'rt-4', code: 'A.4', title: 'Added', section: 'S4', category: null, description: 'd4' },
            ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValue([]);

        const diff = await computeRequirementsDiff(ctx, 'iso-2013', 'iso-2022');

        expect(diff.added).toEqual([
            { code: 'A.4', title: 'Added', section: 'S4' },
        ]);
        expect(diff.removed).toEqual([
            { code: 'A.2', title: 'Removed', section: 'S1' },
        ]);
        expect(diff.changed).toEqual([
            {
                code: 'A.1',
                changes: ['title'],
                from: { title: 'Old', section: 'Cat-A', description: 'd1' }, // section falls back to category
                to: { title: 'New', section: 'Cat-A', description: 'd1' },
            },
        ]);
        expect(diff.summary).toEqual({
            added: 1,
            removed: 1,
            changed: 1,
            unmappedNewRequirements: 1,
        });
    });

    it('detects section + description changes', async () => {
        setupFrameworks();
        prismaMock.frameworkRequirement.findMany
            .mockResolvedValueOnce([
                { id: 'rf-1', code: 'A.1', title: 'Same', section: 'X', category: null, description: 'd1' },
            ])
            .mockResolvedValueOnce([
                { id: 'rt-1', code: 'A.1', title: 'Same', section: 'Y', category: null, description: 'd2' },
            ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValue([]);

        const diff = await computeRequirementsDiff(ctx, 'iso-2013', 'iso-2022');
        expect(diff.changed).toHaveLength(1);
        // Both section AND description differ — both appear in the
        // changes list (title does not).
        expect(diff.changed[0].changes.sort()).toEqual(['description', 'section']);
        // The page shows a description change, so the diff carries both texts.
        expect(diff.changed[0].from.description).toBe('d1');
        expect(diff.changed[0].to.description).toBe('d2');
    });

    it('skips the mapping check when nothing was added', async () => {
        setupFrameworks();
        prismaMock.frameworkRequirement.findMany
            .mockResolvedValueOnce([
                { id: 'rf-1', code: 'A.1', title: 'Same', section: null, category: null, description: 'd' },
            ])
            .mockResolvedValueOnce([
                { id: 'rt-1', code: 'A.1', title: 'Same', section: null, category: null, description: 'd' },
            ]);
        const out = await computeRequirementsDiff(ctx, 'iso-2013', 'iso-2022');
        // controlRequirementLink lookup never runs when added.length===0.
        expect(tenantDb.controlRequirementLink.findMany).not.toHaveBeenCalled();
        expect(out.summary.unmappedNewRequirements).toBe(0);
    });

    it('counts already-mapped new requirements as zero unmapped', async () => {
        setupFrameworks();
        prismaMock.frameworkRequirement.findMany
            .mockResolvedValueOnce([
                { id: 'rf-1', code: 'A.1', title: 'X', section: null, category: null, description: 'd' },
            ])
            .mockResolvedValueOnce([
                { id: 'rf-1', code: 'A.1', title: 'X', section: null, category: null, description: 'd' },
                { id: 'rt-2', code: 'A.2', title: 'Added', section: null, category: null, description: 'd2' },
            ]);
        // Tenant ALREADY has a control mapped to the new requirement.
        tenantDb.controlRequirementLink.findMany.mockResolvedValue([
            { requirementId: 'rt-2' },
        ]);
        const out = await computeRequirementsDiff(ctx, 'iso-2013', 'iso-2022');
        expect(out.summary.unmappedNewRequirements).toBe(0);
    });
});
