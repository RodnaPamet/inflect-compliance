/**
 * `bulkSetAssetStatus`, `bulkAssignAsset`, `bulkDeleteAsset` — the three
 * table-action-bar mutations. All three were uncovered (asset.ts 670-754),
 * which is most of why that file sat at 80% FUNCTION coverage.
 *
 * WHY A SEPARATE FILE. `tests/unit/asset-usecase.test.ts` mocks
 * `AssetRepository` by listing its methods one by one, and that list predates
 * `listByIds` and `bulkUpdate` — so both arrive as `undefined` and every bulk
 * path throws before reaching anything worth asserting. That is the recorded
 * "factory mock that lists functions one by one" hazard: the next export added
 * to the real class is silently absent from the double. Rather than extend a
 * 900-line fixture, this file carries a mock that covers what these three
 * actually call, and says so.
 *
 * The properties under test are authorization tier and tenant scoping, not
 * row counts — these are the paths a table checkbox reaches with N ids in one
 * request.
 */

const mockDb = {
    asset: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/AssetRepository', () => ({
    AssetRepository: {
        listByIds: jest.fn(),
        bulkUpdate: jest.fn().mockResolvedValue({ count: 0 }),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/cache/list-cache', () => ({ bumpEntityCacheVersion: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/observability', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    log: jest.fn(),
    traceUsecase: jest.fn(async (_n: string, fn: () => unknown) => fn()),
}));

import {
    bulkSetAssetStatus,
    bulkAssignAsset,
    bulkDeleteAsset,
} from '@/app-layer/usecases/asset';
import { AssetRepository } from '@/app-layer/repositories/AssetRepository';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../helpers/make-context';

const mockListByIds = AssetRepository.listByIds as jest.Mock;
const mockBulkUpdate = AssetRepository.bulkUpdate as jest.Mock;
const mockLog = logEvent as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    mockListByIds.mockResolvedValue([]);
    mockBulkUpdate.mockResolvedValue({ count: 0 });
    mockDb.asset.deleteMany.mockResolvedValue({ count: 0 });
});

const rows = (...ids: string[]) => ids.map((id) => ({ id, name: `asset ${id}` }));

// ─── Authorization tiers ────────────────────────────────────────────
//
// The two update paths take canWrite; DELETE takes canAdmin. That gap is
// deliberate and is the thing most likely to be flattened by someone
// "tidying up" three adjacent functions that otherwise look identical.

describe('bulk asset actions — permission tiers', () => {
    it('bulkSetAssetStatus and bulkAssignAsset require canWrite (EDITOR passes)', async () => {
        mockListByIds.mockResolvedValue(rows('a1'));
        await expect(bulkSetAssetStatus(makeRequestContext('EDITOR'), ['a1'], 'RETIRED')).resolves.toEqual({ updated: 1 });
        await expect(bulkAssignAsset(makeRequestContext('EDITOR'), ['a1'], 'u1')).resolves.toEqual({ updated: 1 });
    });

    it('both refuse a READER', async () => {
        await expect(bulkSetAssetStatus(makeRequestContext('READER'), ['a1'], 'RETIRED')).rejects.toThrow();
        await expect(bulkAssignAsset(makeRequestContext('READER'), ['a1'], 'u1')).rejects.toThrow();
        expect(mockBulkUpdate).not.toHaveBeenCalled();
    });

    // The asymmetry. An EDITOR may retire and reassign assets in bulk; only an
    // ADMIN may delete them. A single-tier "bulk actions need write" would pass
    // every other test in this file.
    it('bulkDeleteAsset requires canAdmin — an EDITOR is refused', async () => {
        await expect(bulkDeleteAsset(makeRequestContext('EDITOR'), ['a1'])).rejects.toThrow();
        // Load-bearing: the throw alone does not say nothing was deleted.
        expect(mockDb.asset.deleteMany).not.toHaveBeenCalled();
        await expect(bulkDeleteAsset(makeRequestContext('ADMIN'), ['a1'])).resolves.toBeDefined();
    });
});

// ─── The empty selection ────────────────────────────────────────────

describe('bulk asset actions — nothing matched', () => {
    it.each([
        ['bulkSetAssetStatus', () => bulkSetAssetStatus(makeRequestContext('ADMIN'), ['ghost'], 'RETIRED')],
        ['bulkAssignAsset', () => bulkAssignAsset(makeRequestContext('ADMIN'), ['ghost'], 'u1')],
        ['bulkDeleteAsset', () => bulkDeleteAsset(makeRequestContext('ADMIN'), ['ghost'])],
    ])('%s writes nothing and audits nothing when the read returns no rows', async (_name, call) => {
        mockListByIds.mockResolvedValue([]);
        await call();
        // All three early-return on `rows.length === 0`. Without this, a
        // selection of ids that all belong to another tenant would still emit
        // an updateMany and a burst of audit rows about assets we cannot see.
        expect(mockBulkUpdate).not.toHaveBeenCalled();
        expect(mockDb.asset.deleteMany).not.toHaveBeenCalled();
        expect(mockLog).not.toHaveBeenCalled();
    });
});

// ─── Tenant scoping + audit derivation ──────────────────────────────

describe('bulk asset actions — scoping and audit', () => {
    it('audits one row per asset the TENANT-SCOPED read returned, not per id supplied', async () => {
        // Caller passes three ids; only two are ours.
        mockListByIds.mockResolvedValue(rows('a1', 'a2'));
        const out = await bulkSetAssetStatus(makeRequestContext('ADMIN'), ['a1', 'a2', 'other-tenants-asset'], 'RETIRED');

        expect(out).toEqual({ updated: 2 });
        expect(mockLog).toHaveBeenCalledTimes(2);
        const auditedIds = mockLog.mock.calls.map((c) => c[2].entityId).sort();
        expect(auditedIds).toEqual(['a1', 'a2']);
        // The foreign id must never appear in the trail — an audit row naming
        // an asset from another tenant is a cross-tenant disclosure in the one
        // table that is supposed to be evidence.
        expect(JSON.stringify(mockLog.mock.calls)).not.toContain('other-tenants-asset');
    });

    it('bulkDeleteAsset deletes the ids it READ, scoped to the tenant', async () => {
        mockListByIds.mockResolvedValue(rows('a1', 'a2'));
        const out = await bulkDeleteAsset(makeRequestContext('ADMIN', { tenantId: 't-7' }), ['a1', 'a2', 'foreign']);

        expect(out).toEqual({ deleted: 2 });
        // Not the caller's list — the read's. Passing `assetIds` straight
        // through would rely entirely on the tenantId clause below.
        expect(mockDb.asset.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ['a1', 'a2'] }, tenantId: 't-7' },
        });
    });

    it('records SOFT_DELETE, not DELETE', async () => {
        mockListByIds.mockResolvedValue(rows('a1'));
        await bulkDeleteAsset(makeRequestContext('ADMIN'), ['a1']);
        expect(mockLog.mock.calls[0][2]).toMatchObject({
            action: 'SOFT_DELETE',
            entityType: 'Asset',
            entityId: 'a1',
        });
    });
});

// ─── Owner three-state ──────────────────────────────────────────────

describe('bulkAssignAsset — owner value', () => {
    it('assigns a real owner', async () => {
        mockListByIds.mockResolvedValue(rows('a1'));
        await bulkAssignAsset(makeRequestContext('ADMIN'), ['a1'], 'user-9');
        expect(mockBulkUpdate).toHaveBeenCalledWith(
            expect.anything(), expect.anything(), ['a1'], { ownerUserId: 'user-9' },
        );
        expect(mockLog.mock.calls[0][2].details).toMatch(/reassigned/);
    });

    // `ownerUserId || null` — so an empty string from a cleared form control
    // unassigns rather than writing '' into the column, which would be an
    // owner that matches no user and renders as an empty name.
    it.each([[null], ['']])('treats %p as an explicit unassign', async (value) => {
        mockListByIds.mockResolvedValue(rows('a1'));
        await bulkAssignAsset(makeRequestContext('ADMIN'), ['a1'], value as string | null);
        expect(mockBulkUpdate).toHaveBeenCalledWith(
            expect.anything(), expect.anything(), ['a1'], { ownerUserId: null },
        );
        expect(mockLog.mock.calls[0][2].details).toMatch(/cleared/);
    });
});

describe('bulkSetAssetStatus — status value', () => {
    it.each([['ACTIVE'], ['RETIRED']])('passes %s through to the bulk update', async (status) => {
        mockListByIds.mockResolvedValue(rows('a1'));
        await bulkSetAssetStatus(makeRequestContext('ADMIN'), ['a1'], status as 'ACTIVE' | 'RETIRED');
        expect(mockBulkUpdate).toHaveBeenCalledWith(
            expect.anything(), expect.anything(), ['a1'], { status },
        );
        expect(mockLog.mock.calls[0][2].detailsJson).toMatchObject({
            changedFields: ['status'],
            after: { status },
        });
    });
});
