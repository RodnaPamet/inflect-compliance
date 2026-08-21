/**
 * `POST /api/t/:tenantSlug/admin/files/:fileId/clear-quarantine` — the
 * HTTP entrance to the quarantine escape hatch.
 *
 * The usecase's own gate is covered in `file-quarantine-clear.test.ts`;
 * this file proves the ROUTE is wired to the right key. The failure it
 * exists to catch is a future edit softening the gate to `admin.manage`
 * — which reads like a harmless tidy-up and would hand every ADMIN the
 * ability to put suspected malware back in front of downloaders.
 *
 * Also asserts the declarative side: `ROUTE_PERMISSIONS` resolves this
 * path to the same key. The runtime middleware and the map are two
 * separate mechanisms (SDK generation and the docs read the map), so
 * they are asserted separately.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) =>
        getTenantCtxMock(params, req),
}));

// The AUTHZ_DENIED row `requirePermission` writes on denial must not
// reach a real DB in a unit test.
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn(async () => ({
        id: 'audit-x',
        entryHash: 'hash-x',
        previousHash: null,
    })),
}));

const clearFileQuarantineMock = jest.fn();
jest.mock('@/app-layer/usecases/file-quarantine', () => ({
    ...jest.requireActual('@/app-layer/usecases/file-quarantine'),
    clearFileQuarantine: (...args: unknown[]) =>
        clearFileQuarantineMock(...args),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/t/[tenantSlug]/admin/files/[fileId]/clear-quarantine/route';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';

function ctxFor(role: 'OWNER' | 'ADMIN' | 'EDITOR') {
    return {
        requestId: 'req-1',
        userId: `${role.toLowerCase()}-1`,
        tenantId: 'tenant-A',
        role,
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: role === 'OWNER' || role === 'ADMIN',
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole(role),
    };
}

const REASON = 'Vendor confirmed signature set 27.9 misfires on signed PDFs';

function req(body: unknown = { reason: REASON }): NextRequest {
    return new NextRequest(
        'http://localhost/api/t/acme/admin/files/file-1/clear-quarantine',
        {
            method: 'POST',
            headers: new Headers({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
        },
    );
}

const routeArgs = {
    params: Promise.resolve({ tenantSlug: 'acme', fileId: 'file-1' }),
};

beforeEach(() => {
    jest.clearAllMocks();
    clearFileQuarantineMock.mockResolvedValue({
        fileId: 'file-1',
        originalName: 'soc2-report.pdf',
        scanStatus: 'CLEAN',
        status: 'STORED',
        auditLogId: 'audit-1',
    });
});

describe('POST …/admin/files/:fileId/clear-quarantine', () => {
    it('refuses an ADMIN with 403 and never reaches the usecase', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('ADMIN'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(req(), routeArgs as any);

        expect(res.status).toBe(403);
        expect(clearFileQuarantineMock).not.toHaveBeenCalled();
    });

    it('refuses an EDITOR with 403', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('EDITOR'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(req(), routeArgs as any);
        expect(res.status).toBe(403);
        expect(clearFileQuarantineMock).not.toHaveBeenCalled();
    });

    it('lets an OWNER through, forwarding the resolved fileId + reason', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(req(), routeArgs as any);

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
            fileId: 'file-1',
            scanStatus: 'CLEAN',
            auditLogId: 'audit-1',
        });

        expect(clearFileQuarantineMock).toHaveBeenCalledTimes(1);
        const [ctx, input] = clearFileQuarantineMock.mock.calls[0];
        expect(ctx.tenantId).toBe('tenant-A');
        // Read off the RESOLVED params, not the still-pending Promise.
        expect(input).toEqual({ fileId: 'file-1', reason: REASON });
    });

    it('rejects a body with no reason before the usecase runs', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(req({}), routeArgs as any);

        expect(res.status).toBe(400);
        expect(clearFileQuarantineMock).not.toHaveBeenCalled();
    });
});

describe('route-permission map', () => {
    it('declares the OWNER-only key for this path', () => {
        const rule = resolveRoutePermission(
            '/api/t/acme/admin/files/file-1/clear-quarantine',
            'POST',
        );
        expect(rule?.permission).toBe('admin.tenant_lifecycle');
    });

    it('the key it names is one ADMIN does not hold', () => {
        expect(getPermissionsForRole('OWNER').admin.tenant_lifecycle).toBe(true);
        expect(getPermissionsForRole('ADMIN').admin.tenant_lifecycle).toBe(false);
    });
});
