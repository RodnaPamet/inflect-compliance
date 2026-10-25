/**
 * `GET /api/t/:tenantSlug/controls?includeDeleted=true` — the Controls
 * page's "Deleted controls" view.
 *
 * Two route-level claims (#4275):
 *
 *   1. The view keeps the toolbar's search and filters active, and the route
 *      used to answer it with `listControlsWithDeleted(ctx)` — no filters at
 *      all — so search, status, applicability, owner, health and the
 *      dashboard drill-downs were silently dropped there. The ROUTE now
 *      forwards them; the usecase and repository tests prove what is done
 *      with them.
 *   2. The branch is gated `admin.manage` (beside `controls.view`) by the
 *      middleware, like the view's Restore / Purge. It was `controls.view`
 *      alone, so a refusal came from the usecase's `assertCanAdmin` and
 *      wrote no AUTHZ_DENIED row.
 */
import { strictMock } from '../helpers/strict-mock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// The AUTHZ_DENIED row a middleware refusal writes. `strictMock`: `@/lib/audit`
// is a guarded barrel, so an export this fixture forgot fails loudly.
const mockAppendAuditEntryOrQueue = jest.fn(async (_entry: unknown) => ({
    recorded: 'chain' as const,
    auditId: 'audit-x',
}));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (entry: unknown) => mockAppendAuditEntryOrQueue(entry),
    }),
);

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

/** A custom role on an ADMIN base with `admin.manage` switched off — the
 *  coarse tier says admin, the key the view's actions name says no. */
const adminWithoutManage = {
    ...ctx,
    userId: 'custom-1',
    role: 'ADMIN',
    appPermissions: {
        ...getPermissionsForRole('ADMIN'),
        admin: { ...getPermissionsForRole('ADMIN').admin, manage: false },
    },
};

beforeEach(() => {
    getTenantCtxMock.mockReset();
    getTenantCtxMock.mockResolvedValue(ctx);
    listControlsWithDeletedMock.mockClear();
    listControlsMock.mockClear();
    mockAppendAuditEntryOrQueue.mockClear();
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

describe('the Deleted view is gated admin.manage at the route', () => {
    it('refuses a caller without admin.manage with a 403 and an AUTHZ_DENIED row', async () => {
        getTenantCtxMock.mockResolvedValue(adminWithoutManage);
        const res = await get('?includeDeleted=true');
        expect(res.status).toBe(403);
        // The middleware refused — the usecase never ran.
        expect(listControlsWithDeletedMock).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
        expect(mockAppendAuditEntryOrQueue.mock.calls[0][0]).toMatchObject({
            action: 'AUTHZ_DENIED',
            tenantId: 'tenant-A',
            userId: 'custom-1',
        });
        // A generic refusal: the key is not echoed to the client.
        expect(JSON.stringify(await res.json())).not.toContain('admin.manage');
    });

    it('a READER is refused the same way', async () => {
        getTenantCtxMock.mockResolvedValue({
            ...ctx,
            role: 'READER',
            permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
            appPermissions: getPermissionsForRole('READER'),
        });
        const res = await get('?includeDeleted=true');
        expect(res.status).toBe(403);
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
    });

    it('the live list is NOT gated admin.manage — the same caller still reads it', async () => {
        getTenantCtxMock.mockResolvedValue(adminWithoutManage);
        const res = await get('?status=IMPLEMENTED');
        expect(res.status).toBe(200);
        expect(listControlsMock).toHaveBeenCalledTimes(1);
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });
});
