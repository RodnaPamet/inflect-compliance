/**
 * `GET /api/t/:tenantSlug/admin/files/quarantined` — the HTTP entrance
 * to the quarantine list.
 *
 * The usecase's own gate is covered in `file-quarantine-list.test.ts`;
 * this file proves the ROUTE is wired to the right key and forwards the
 * paging arguments it was given. The failure it exists to catch is a
 * future edit softening the gate to `admin.manage` — which reads like a
 * harmless tidy-up ("it's only a read") and would hand every ADMIN a map
 * of the malware in the tenant's evidence library plus the fileId the
 * OWNER-only reversal consumes.
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

const listQuarantinedFilesMock = jest.fn(
    async (_ctx: unknown, _options?: unknown) => ({
        files: [] as unknown[],
        nextCursor: null as string | null,
    }),
);
jest.mock('@/app-layer/usecases/file-quarantine', () => ({
    ...jest.requireActual('@/app-layer/usecases/file-quarantine'),
    listQuarantinedFiles: (ctx: unknown, options?: unknown) =>
        listQuarantinedFilesMock(ctx, options),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/admin/files/quarantined/route';
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

function req(query = ''): NextRequest {
    return new NextRequest(
        `http://localhost/api/t/acme/admin/files/quarantined${query}`,
        { method: 'GET' },
    );
}

const routeArgs = { params: Promise.resolve({ tenantSlug: 'acme' }) };

const ROW = {
    fileId: 'file-1',
    originalName: 'soc2-report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4096,
    sha256: 'abc123',
    domain: 'evidence',
    status: 'FAILED',
    quarantinedAt: new Date('2026-08-01T00:00:00.000Z'),
    uploadedAt: new Date('2026-07-31T00:00:00.000Z'),
    uploadedByUserId: 'uploader-1',
    verdict: {
        engine: 'clamav',
        threat: 'Eicar-Test-Signature',
        source: null,
        unparsed: false,
    },
};

beforeEach(() => {
    jest.clearAllMocks();
    listQuarantinedFilesMock.mockResolvedValue({
        files: [ROW],
        nextCursor: 'file-1',
    });
});

describe('GET …/admin/files/quarantined', () => {
    it('refuses an ADMIN with 403 and never reaches the usecase', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('ADMIN'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET(req(), routeArgs as any);

        expect(res.status).toBe(403);
        expect(listQuarantinedFilesMock).not.toHaveBeenCalled();
    });

    it('refuses an EDITOR with 403', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('EDITOR'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET(req(), routeArgs as any);

        expect(res.status).toBe(403);
        expect(listQuarantinedFilesMock).not.toHaveBeenCalled();
    });

    it('lets an OWNER through and returns the page plus its cursor', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET(req(), routeArgs as any);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.nextCursor).toBe('file-1');
        expect(body.files).toHaveLength(1);
        expect(body.files[0]).toMatchObject({
            fileId: 'file-1',
            originalName: 'soc2-report.pdf',
            verdict: { engine: 'clamav', threat: 'Eicar-Test-Signature' },
        });

        expect(listQuarantinedFilesMock).toHaveBeenCalledTimes(1);
        const [ctx] = listQuarantinedFilesMock.mock.calls[0];
        expect((ctx as { tenantId: string }).tenantId).toBe('tenant-A');
    });

    it('forwards limit + cursor from the query string', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await GET(req('?limit=25&cursor=file-9'), routeArgs as any);

        expect(listQuarantinedFilesMock.mock.calls[0][1]).toEqual({
            limit: 25,
            cursor: 'file-9',
        });
    });

    it('ignores a non-numeric limit instead of 400-ing an incident surface', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET(req('?limit=lots'), routeArgs as any);

        expect(res.status).toBe(200);
        expect(listQuarantinedFilesMock.mock.calls[0][1]).toEqual({
            limit: undefined,
            cursor: undefined,
        });
    });
});

describe('route-permission map', () => {
    it('declares the OWNER-only key for this path', () => {
        const rule = resolveRoutePermission(
            '/api/t/acme/admin/files/quarantined',
            'GET',
        );
        expect(rule?.permission).toBe('admin.tenant_lifecycle');
    });

    it('does not shadow the reversal rule for the sibling path', () => {
        const reversal = resolveRoutePermission(
            '/api/t/acme/admin/files/file-1/clear-quarantine',
            'POST',
        );
        expect(reversal?.permission).toBe('admin.tenant_lifecycle');
        // `methods` lives on the RULE, not on the resolved wrapper — an
        // omitted `methods` means the rule covers every verb, which is what
        // makes the reversal rule un-shadowed here.
        expect(reversal?.rule.methods).toBeUndefined();
    });

    it('the key both name is one ADMIN does not hold', () => {
        expect(getPermissionsForRole('OWNER').admin.tenant_lifecycle).toBe(true);
        expect(getPermissionsForRole('ADMIN').admin.tenant_lifecycle).toBe(false);
    });
});
