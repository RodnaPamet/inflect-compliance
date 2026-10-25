/**
 * `GET /api/t/:tenantSlug/controls?includeDeleted=true` — the Controls
 * page's "Deleted controls" view.
 *
 * The view keeps the toolbar's search and filters active, and the route used
 * to answer it with `listControlsWithDeleted(ctx)` — no filters at all — so
 * search, status, applicability, owner, health and the dashboard drill-downs
 * were silently dropped there. This file proves the ROUTE forwards them; the
 * usecase and repository tests prove what is done with them.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

const listControlsWithDeletedMock = jest.fn(async (_ctx: unknown, _filters?: unknown) => [] as unknown[]);
const listControlsMock = jest.fn(async () => [] as unknown[]);
jest.mock('@/app-layer/usecases/control', () => ({
    listControls: () => listControlsMock(),
    listControlKpiCounts: jest.fn(async () => ({ total: 0, implemented: 0, inProgress: 0, notStarted: 0 })),
    listControlsPaginated: jest.fn(),
    createControl: jest.fn(),
    listControlsWithDeleted: (ctx: unknown, filters?: unknown) => listControlsWithDeletedMock(ctx, filters),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/controls/route';
import { getPermissionsForRole } from '@/lib/permissions';

const ctx = {
    requestId: 'req-1',
    userId: 'owner-1',
    tenantId: 'tenant-A',
    role: 'OWNER',
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

beforeEach(() => {
    getTenantCtxMock.mockReset();
    getTenantCtxMock.mockResolvedValue(ctx);
    listControlsWithDeletedMock.mockClear();
    listControlsMock.mockClear();
});

function get(qs: string) {
    return GET(new NextRequest(`http://localhost/api/t/acme/controls${qs}`, { method: 'GET' }), {
        params: Promise.resolve({ tenantSlug: 'acme' }),
    });
}

describe('GET /controls?includeDeleted=true', () => {
    it('forwards the toolbar filters to the deleted-view read', async () => {
        const res = await get(
            '?includeDeleted=true&q=vpn&status=IMPLEMENTED,NEEDS_REVIEW&applicability=APPLICABLE' +
                '&ownerUserId=u-1,u-2&health=AT_RISK&due=soon&evidence=missing&ids=c-1,c-2',
        );
        expect(res.status).toBe(200);
        expect(listControlsWithDeletedMock).toHaveBeenCalledTimes(1);
        expect(listControlsMock).not.toHaveBeenCalled();
        const [calledCtx, filters] = listControlsWithDeletedMock.mock.calls[0];
        expect(calledCtx).toBe(ctx);
        expect(filters).toEqual({
            q: 'vpn',
            status: 'IMPLEMENTED,NEEDS_REVIEW',
            applicability: 'APPLICABLE',
            ownerUserId: 'u-1,u-2',
            health: 'AT_RISK',
            due: 'soon',
            evidence: 'missing',
            ids: 'c-1,c-2',
        });
    });

    it('still returns the deleted view as a bare array', async () => {
        listControlsWithDeletedMock.mockResolvedValueOnce([{ id: 'c-9' }]);
        const res = await get('?includeDeleted=true');
        expect(await res.json()).toEqual([{ id: 'c-9' }]);
    });
});
