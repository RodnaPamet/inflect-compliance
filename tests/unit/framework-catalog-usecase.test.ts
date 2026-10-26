/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Wave-C coverage — framework catalog usecase (previously 0% branches).
 *
 * Global (non-tenant) framework reads. Each accessor has a
 * version-present vs version-absent branch (findUnique vs findFirst) and
 * a not-found throw. Prisma is mocked at the boundary; the real
 * `assertCanViewFrameworks` policy runs against an ADMIN ctx.
 */

jest.mock('@/lib/prisma', () => ({
    prisma: {
        framework: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
        frameworkRequirement: { findMany: jest.fn() },
        frameworkPack: { findMany: jest.fn() },
    },
}));

// listFrameworkPacks reads which packs this workspace chose in its tenant context.
const tenantDb = { tenantFrameworkPack: { findMany: jest.fn() } };
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, cb: (db: unknown) => unknown) => cb(tenantDb)),
}));

import { prisma } from '@/lib/prisma';
import { notFound } from '@/lib/errors/types';
import {
    listFrameworks,
    getFramework,
    getFrameworkRequirements,
    listFrameworkPacks,
} from '@/app-layer/usecases/framework/catalog';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');
const p = prisma as any;

beforeEach(() => jest.clearAllMocks());

describe('listFrameworks', () => {
    it('returns frameworks ordered by key with counts', async () => {
        // The query's `include` always carries `_count.packs`; the offer filter reads it.
        const row = { key: 'ISO27001', sourceUrn: null, _count: { requirements: 0, packs: 1 } };
        p.framework.findMany.mockResolvedValue([row]);
        const r = await listFrameworks(ctx);
        expect(r).toEqual([row]);
        expect(p.framework.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { key: 'asc' } }),
        );
    });
});

describe('getFramework', () => {
    it('uses findUnique on key_version when a version is given', async () => {
        p.framework.findUnique.mockResolvedValue({ id: 'fw1' });
        await getFramework(ctx, 'ISO27001', '2022');
        // Branch: version present → findUnique with composite key.
        expect(p.framework.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { key_version: { key: 'ISO27001', version: '2022' } } }),
        );
        expect(p.framework.findFirst).not.toHaveBeenCalled();
    });

    it('uses findFirst on key when no version is given', async () => {
        p.framework.findFirst.mockResolvedValue({ id: 'fw1' });
        await getFramework(ctx, 'ISO27001');
        // Branch: version absent → findFirst by key.
        expect(p.framework.findFirst).toHaveBeenCalled();
        expect(p.framework.findUnique).not.toHaveBeenCalled();
    });

    it('throws notFound when the framework is missing', async () => {
        p.framework.findFirst.mockResolvedValue(null);
        await expect(getFramework(ctx, 'NOPE')).rejects.toThrow(notFound('Framework not found'));
    });
});

describe('getFrameworkRequirements', () => {
    it('resolves the framework (versioned) then lists its requirements ordered', async () => {
        p.framework.findUnique.mockResolvedValue({ id: 'fw1' });
        p.frameworkRequirement.findMany.mockResolvedValue([{ id: 'r1' }]);
        const r = await getFrameworkRequirements(ctx, 'ISO27001', '2022');
        expect(r).toEqual([{ id: 'r1' }]);
        expect(p.frameworkRequirement.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { frameworkId: 'fw1' }, orderBy: { sortOrder: 'asc' } }),
        );
    });

    it('throws notFound when the framework is missing', async () => {
        p.framework.findFirst.mockResolvedValue(null);
        await expect(getFrameworkRequirements(ctx, 'NOPE')).rejects.toThrow('Framework not found');
        expect(p.frameworkRequirement.findMany).not.toHaveBeenCalled();
    });
});

describe('listFrameworkPacks', () => {
    it('resolves the framework (unversioned) then lists its packs', async () => {
        p.framework.findFirst.mockResolvedValue({ id: 'fw1' });
        p.frameworkPack.findMany.mockResolvedValue([{ id: 'pack1' }]);
        tenantDb.tenantFrameworkPack.findMany.mockResolvedValue([]);
        const r = await listFrameworkPacks(ctx, 'ISO27001');
        expect(r).toEqual([{ id: 'pack1', chosen: false }]);
        expect(p.frameworkPack.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { frameworkId: 'fw1' } }),
        );
    });

    it('marks the packs this workspace chose, reading only its own records (#4372)', async () => {
        p.framework.findFirst.mockResolvedValue({ id: 'fw-uas' });
        p.frameworkPack.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]);
        tenantDb.tenantFrameworkPack.findMany.mockResolvedValue([{ packId: 'a2' }, { packId: 'a3' }]);
        const r = await listFrameworkPacks(ctx, 'EU-UAS-OPS');
        expect(r.map((x: any) => [x.id, x.chosen])).toEqual([['a1', false], ['a2', true], ['a3', true]]);
        expect(tenantDb.tenantFrameworkPack.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: ctx.tenantId, frameworkId: 'fw-uas' }, take: 3 }),
        );
    });

    it('throws notFound when the framework is missing', async () => {
        p.framework.findUnique.mockResolvedValue(null);
        await expect(listFrameworkPacks(ctx, 'NOPE', '2022')).rejects.toThrow('Framework not found');
        expect(p.frameworkPack.findMany).not.toHaveBeenCalled();
    });
});
