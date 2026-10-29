import { AssetRiskRepository } from '@/app-layer/repositories/TraceabilityRepository';

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => undefined),
}));

const mockFindUnique = jest.fn();
const mockUpsert = jest.fn();
// mapAssetToRisk verifies both the asset and the risk exist in the tenant
// before linking — the tx mock returns a row for each so the existence checks
// pass and the audit-differentiation behaviour under test is reached.
const mockAssetFindFirst = jest.fn().mockResolvedValue({ id: 'asset-1' });
const mockRiskFindFirst = jest.fn().mockResolvedValue({ id: 'risk-1' });
const mockTx = {
    assetRiskLink: { findUnique: mockFindUnique, upsert: mockUpsert },
    asset: { findFirst: mockAssetFindFirst },
    risk: { findFirst: mockRiskFindFirst },
};

import { mapAssetToRisk } from '@/app-layer/usecases/traceability';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../helpers/make-context';

/**
 * A REAL context, not a stub.
 *
 * This was `{ role: 'EDITOR', permissions: {}, appPermissions: {} }`, which
 * satisfied the file-local role-NAME check `mapAssetToRisk` used to sit behind
 * — `['OWNER','ADMIN','EDITOR'].includes(ctx.role)` reads nothing else. Since
 * #4413 the gate is `assets.edit` (`canWrite` AND the granular key), and an
 * empty `permissions` fails the coarse half before the granular one is
 * reached. These tests are about the LINK's emit logic, so they need a context
 * that gets past the gate rather than one shaped by the gate it was written
 * against.
 */
const ctx = makeRequestContext('EDITOR', { userId: 'user-1', tenantId: 'tenant-1' });

describe('AssetRiskRepository.link — idempotent upsert shape', () => {
    it('uses upsert keyed on the composite unique', async () => {
        const upsert = jest.fn().mockResolvedValue({ id: 'edge-1' });
        const db = { assetRiskLink: { upsert } } as never;
        await AssetRiskRepository.link(db, 'tenant-1', 'asset-1', 'risk-1', 'HIGH', 'because', 'user-1');
        expect(upsert).toHaveBeenCalledTimes(1);
        const arg = upsert.mock.calls[0][0];
        expect(arg.where.tenantId_assetId_riskId).toEqual({
            tenantId: 'tenant-1', assetId: 'asset-1', riskId: 'risk-1',
        });
        expect(arg.create).toMatchObject({
            tenantId: 'tenant-1', assetId: 'asset-1', riskId: 'risk-1',
            exposureLevel: 'HIGH', rationale: 'because', createdByUserId: 'user-1',
        });
        expect(arg.update).toMatchObject({ exposureLevel: 'HIGH', rationale: 'because' });
    });

    it('re-link without fields leaves the existing edge alone', async () => {
        const upsert = jest.fn().mockResolvedValue({ id: 'edge-1' });
        const db = { assetRiskLink: { upsert } } as never;
        await AssetRiskRepository.link(db, 'tenant-1', 'asset-1', 'risk-1', null, null, 'user-1');
        const arg = upsert.mock.calls[0][0];
        expect(arg.create.exposureLevel).toBe('MEDIUM');
        expect(arg.update).toEqual({});
    });
});

describe('mapAssetToRisk — audit differentiation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('logs ASSET_RISK_LINKED for a new link', async () => {
        mockFindUnique.mockResolvedValue(null);
        mockUpsert.mockResolvedValue({ id: 'edge-1', exposureLevel: 'HIGH', rationale: 'reason' });
        await mapAssetToRisk(ctx, 'asset-1', 'risk-1', 'HIGH', 'reason');
        expect(logEvent).toHaveBeenCalledTimes(1);
        expect((logEvent as jest.Mock).mock.calls[0][2].action).toBe('ASSET_RISK_LINKED');
    });

    it('logs ASSET_RISK_UPDATED when fields change on re-link', async () => {
        mockFindUnique.mockResolvedValue({ id: 'edge-1', exposureLevel: 'MEDIUM', rationale: null });
        mockUpsert.mockResolvedValue({ id: 'edge-1', exposureLevel: 'HIGH', rationale: 'updated' });
        await mapAssetToRisk(ctx, 'asset-1', 'risk-1', 'HIGH', 'updated');
        expect(logEvent).toHaveBeenCalledTimes(1);
        expect((logEvent as jest.Mock).mock.calls[0][2].action).toBe('ASSET_RISK_UPDATED');
    });

    it('skips audit on no-op re-link', async () => {
        mockFindUnique.mockResolvedValue({ id: 'edge-1', exposureLevel: 'HIGH', rationale: 'reason' });
        mockUpsert.mockResolvedValue({ id: 'edge-1', exposureLevel: 'HIGH', rationale: 'reason' });
        await mapAssetToRisk(ctx, 'asset-1', 'risk-1');
        expect(logEvent).not.toHaveBeenCalled();
    });
});
