/**
 * The "Deleted assets" and "Deleted controls" views read `data.rows`, like
 * every list page. The asset route's deleted branch returned a bare array,
 * so the view said "No deleted assets" whatever had been deleted and Restore
 * and Purge could not be reached (#4276). The controls route's deleted branch
 * took no filters at all (#4275).
 *
 * This holds the ROUTE side of both: the response shape the client reads, and
 * the page's filters reaching the deleted read. What the read returns is held
 * against Postgres in
 * `tests/integration/list-multi-select-and-deleted-views.test.ts` and
 * `tests/integration/deleted-assets-and-vuln-fold.test.ts`.
 */
import { strictMock } from '../helpers/strict-mock';

const getTenantCtxMock = jest.fn<Promise<unknown>, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

jest.mock('@/lib/audit', () =>
    // strictMock, not a bare subset: an export this factory omits names itself
    // when reached, rather than resolving to `undefined` inside the route.
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: jest.fn(async () => ({ recorded: 'chain' as const, auditId: 'audit-x' })),
        appendAuditEntry: jest.fn(async () => ({ id: 'audit-x', entryHash: 'hash-x', previousHash: null })),
    }),
);

const listAssetsWithDeleted = jest.fn();
jest.mock('@/app-layer/usecases/asset', () => ({
    listAssets: jest.fn(),
    listAssetsPaginated: jest.fn(),
    createAsset: jest.fn(),
    listAssetKpiCounts: jest.fn(),
    listAssetsWithDeleted: (...args: unknown[]) => listAssetsWithDeleted(...args),
}));

const listControlsWithDeleted = jest.fn();
jest.mock('@/app-layer/usecases/control', () => ({
    listControls: jest.fn(),
    listControlKpiCounts: jest.fn(),
    listControlsPaginated: jest.fn(),
    createControl: jest.fn(),
    listControlsWithDeleted: (...args: unknown[]) => listControlsWithDeleted(...args),
}));

import { NextRequest } from 'next/server';
import { GET as getAssets } from '@/app/api/t/[tenantSlug]/assets/route';
import { GET as getControls } from '@/app/api/t/[tenantSlug]/controls/route';
import { getPermissionsForRole } from '@/lib/permissions';

const ownerCtx = {
    requestId: 'req-1',
    userId: 'owner-1',
    tenantId: 'tenant-A',
    role: 'OWNER',
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

const routeArgs = { params: { tenantSlug: 'acme' } };

function get(path: string): NextRequest {
    return new NextRequest(`http://localhost/api/t/acme/${path}`, { method: 'GET' });
}

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue(ownerCtx);
});

describe('deleted-view list routes', () => {
    it('assets: answers { rows, truncated }, the shape the page reads', async () => {
        listAssetsWithDeleted.mockResolvedValueOnce([{ id: 'a-1', deletedAt: '2026-10-25T00:00:00.000Z' }]);

        const res = await getAssets(get('assets?includeDeleted=true&q=laptop'), routeArgs);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            rows: [{ id: 'a-1', deletedAt: '2026-10-25T00:00:00.000Z' }],
            truncated: false,
        });
        // One past the cap, so a clipped view can say so.
        const [, filters, options] = listAssetsWithDeleted.mock.calls[0];
        expect(filters).toMatchObject({ q: 'laptop' });
        expect(options.take).toBeGreaterThan(1);
    });

    it('controls: passes the page filters to the deleted read', async () => {
        listControlsWithDeleted.mockResolvedValueOnce([{ id: 'c-1', deletedAt: '2026-10-25T00:00:00.000Z' }]);

        const res = await getControls(
            get('controls?includeDeleted=true&q=mfa&ownerUserId=u-1,u-2&status=IMPLEMENTED'),
            routeArgs,
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            rows: [{ id: 'c-1', deletedAt: '2026-10-25T00:00:00.000Z' }],
            truncated: false,
        });
        const [, filters] = listControlsWithDeleted.mock.calls[0];
        expect(filters).toMatchObject({ q: 'mfa', ownerUserId: 'u-1,u-2', status: 'IMPLEMENTED' });
    });
});
