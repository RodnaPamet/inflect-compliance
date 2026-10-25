/**
 * `GET /api/t/[tenantSlug]/assets` answers in ONE envelope, whichever branch
 * serves it (#4276).
 *
 * The client reads `data.rows` for both the live list and the Deleted assets
 * view (they share one SWR key builder). The `includeDeleted=true` branch
 * returned the bare array from `listAssetsWithDeleted`, so `data.rows` was
 * `undefined`, the view rendered "No deleted assets" however many there were,
 * and Restore and Purge — which live only in that view — were unreachable.
 *
 * Each branch is asserted against the SAME reader, so a branch that drifts
 * from the envelope fails here rather than as an empty table in the browser.
 */
import { NextRequest } from 'next/server';

const mockGetTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => mockGetTenantCtx(...a),
}));

const mockListAssets = jest.fn();
const mockListAssetsWithDeleted = jest.fn();
const mockListAssetKpiCounts = jest.fn();
jest.mock('@/app-layer/usecases/asset', () => ({
    listAssets: (...a: unknown[]) => mockListAssets(...a),
    listAssetsWithDeleted: (...a: unknown[]) => mockListAssetsWithDeleted(...a),
    listAssetKpiCounts: (...a: unknown[]) => mockListAssetKpiCounts(...a),
    listAssetsPaginated: jest.fn(),
    createAsset: jest.fn(),
}));

import { GET } from '@/app/api/t/[tenantSlug]/assets/route';
import { makeRequestContext } from '../helpers/make-context';

const LIVE = [{ id: 'as-1', name: 'Prod DB', deletedAt: null }];
const DELETED = [{ id: 'as-2', name: 'Old NAS', deletedAt: '2026-10-01T09:00:00.000Z' }];

/** What `AssetsClient` does with the body: `data?.rows ?? []`. */
const rowsTheClientReads = (body: { rows?: unknown[] } | unknown[]) =>
    (body as { rows?: unknown[] })?.rows ?? [];

async function get(qs: string) {
    const res = await GET(new NextRequest(`http://localhost/api/t/acme/assets${qs}`), {
        params: Promise.resolve({ tenantSlug: 'acme' }),
    });
    expect(res.status).toBe(200);
    return res.json();
}

beforeEach(() => {
    mockGetTenantCtx.mockResolvedValue(makeRequestContext('ADMIN'));
    mockListAssets.mockReset().mockResolvedValue(LIVE);
    mockListAssetsWithDeleted.mockReset().mockResolvedValue(DELETED);
    mockListAssetKpiCounts.mockReset().mockResolvedValue({ total: 1, active: 1, critical: 0, retired: 0 });
});

describe('GET /assets — one envelope for every branch', () => {
    it('the Deleted assets view gets `{ rows, truncated }`, so its rows reach the table', async () => {
        const body = await get('?includeDeleted=true');
        expect(mockListAssetsWithDeleted).toHaveBeenCalled();
        expect(Array.isArray(body)).toBe(false);
        expect(body).toEqual({ rows: DELETED, truncated: false });
        expect(rowsTheClientReads(body)).toEqual(DELETED);
    });

    it('the live list keeps the same envelope (positive companion)', async () => {
        const body = await get('');
        expect(mockListAssetsWithDeleted).not.toHaveBeenCalled();
        expect(rowsTheClientReads(body)).toEqual(LIVE);
        expect(body.truncated).toBe(false);
    });

    it('the deleted branch still forwards the toolbar filters', async () => {
        await get('?includeDeleted=true&type=SYSTEM&status=RETIRED&criticality=HIGH&q=nas');
        expect(mockListAssetsWithDeleted).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-1' }),
            { type: 'SYSTEM', status: 'RETIRED', criticality: 'HIGH', q: 'nas' },
        );
    });
});
