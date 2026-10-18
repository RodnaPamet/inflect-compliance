/**
 * The two HTTP entrances of the integration passport (#3672), and the key each
 * one holds.
 *
 *   GET admin/integration-passport/{id}      — admin.tenant_lifecycle (OWNER)
 *   PUT admin/integrations/{id}/owner        — admin.manage (OWNER + ADMIN)
 *
 * THE FAILURE THE FIRST HALF EXISTS TO CATCH is the passport being softened to
 * `admin.manage`, or moved under `admin/integrations/` where first-match-wins
 * resolves it there. Either reads like tidying — "it is only a read", "it sits
 * beside the connection" — and would hand every ADMIN the external write rung
 * and the prior-state pairings, which are OWNER reads on their own surfaces.
 *
 * The second half pins the owner setter to the connection-write key the
 * specification names, and to its strict body: a field the route does not
 * declare is a 400, so the PUT cannot become a back door into the rest of the
 * connection row.
 *
 * Each 403 is asserted together with "the usecase was never reached": a refusal
 * produced after the read ran is a disclosure that happens to be discarded, and
 * the status alone cannot tell the two apart. The declarative map is asserted
 * separately, because the runtime middleware and `ROUTE_PERMISSIONS` are two
 * mechanisms and a disagreement between them is a defect of its own.
 */

import { strictMock } from '../helpers/strict-mock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// The AUTHZ_DENIED row `requirePermission` writes on denial must not reach a
// real DB in a unit test. `strictMock`, not a subset factory: `@/lib/audit` is
// a guarded barrel, and an omitted export would resolve to `undefined` and make
// the denial's audit call silently do nothing.
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: jest.fn(async () => ({ recorded: 'chain' as const, auditId: 'audit-x' })),
        appendAuditEntry: jest.fn(async () => ({ id: 'audit-x', entryHash: 'hash-x', previousHash: null })),
    }),
);

const getViewMock = jest.fn(async (_ctx: unknown, _id: string) => ({ current: { connectionId: 'conn_1' } }) as unknown);
const setOwnerMock = jest.fn(async (_ctx: unknown, id: string, owner: string | null) => ({
    connectionId: id,
    ownerUserId: owner,
    changed: true,
}));
jest.mock('@/app-layer/usecases/integration-passport', () => ({
    getIntegrationPassportView: (ctx: unknown, id: string) => getViewMock(ctx, id),
    setIntegrationConnectionOwner: (ctx: unknown, id: string, owner: string | null) => setOwnerMock(ctx, id, owner),
}));

import { NextRequest } from 'next/server';
import { GET as GET_PASSPORT } from '@/app/api/t/[tenantSlug]/admin/integration-passport/[connectionId]/route';
import { PUT as PUT_OWNER } from '@/app/api/t/[tenantSlug]/admin/integrations/[connectionId]/owner/route';
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

const args = { params: Promise.resolve({ tenantSlug: 'acme', connectionId: 'conn_1' }) };

const passportReq = () =>
    new NextRequest('http://localhost/api/t/acme/admin/integration-passport/conn_1', { method: 'GET' });

const ownerReq = (body: unknown) =>
    new NextRequest('http://localhost/api/t/acme/admin/integrations/conn_1/owner', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });

beforeEach(() => {
    jest.clearAllMocks();
});

describe('GET …/admin/integration-passport/{id} — OWNER-only', () => {
    it('refuses an ADMIN with 403 and never reaches the usecase', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('ADMIN'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_PASSPORT(passportReq(), args as any);
        expect(res.status).toBe(403);
        expect(getViewMock).not.toHaveBeenCalled();
    });

    it('refuses an EDITOR with 403', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('EDITOR'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_PASSPORT(passportReq(), args as any);
        expect(res.status).toBe(403);
        expect(getViewMock).not.toHaveBeenCalled();
    });

    it('lets an OWNER through, for the connection in the path, in their own tenant', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_PASSPORT(passportReq(), args as any);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ current: { connectionId: 'conn_1' } });
        const [ctx, id] = getViewMock.mock.calls[0];
        expect((ctx as { tenantId: string }).tenantId).toBe('tenant-A');
        expect(id).toBe('conn_1');
    });

    it('declares admin.tenant_lifecycle in ROUTE_PERMISSIONS, for GET', () => {
        const rule = resolveRoutePermission('/api/t/acme/admin/integration-passport/conn_1', 'GET');
        expect(rule?.permission).toBe('admin.tenant_lifecycle');
    });

    it('is a SIBLING of admin/integrations, which would resolve it to admin.manage', () => {
        const integrations = resolveRoutePermission('/api/t/acme/admin/integrations/conn_1', 'GET');
        expect(integrations?.permission).toBe('admin.manage');
        expect(integrations?.rule.path.test('/api/t/acme/admin/integration-passport/conn_1')).toBe(false);
    });

    it('the key is one an ADMIN does not hold', () => {
        expect(getPermissionsForRole('OWNER').admin.tenant_lifecycle).toBe(true);
        expect(getPermissionsForRole('ADMIN').admin.tenant_lifecycle).toBe(false);
    });
});

describe('PUT …/admin/integrations/{id}/owner — the connection-write key', () => {
    it('refuses an EDITOR with 403 and never reaches the usecase', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('EDITOR'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await PUT_OWNER(ownerReq({ ownerUserId: 'u2' }), args as any);
        expect(res.status).toBe(403);
        expect(setOwnerMock).not.toHaveBeenCalled();
    });

    it('refuses a custom role that may VIEW admin but not manage connections', async () => {
        // No built-in role tells `admin.view` from `admin.manage` — OWNER and
        // ADMIN hold both, the rest neither — so a gate softened to the
        // layout's own `admin.view` would pass every built-in-role assertion
        // above. A custom role is where the two keys come apart.
        const base = ctxFor('ADMIN');
        getTenantCtxMock.mockResolvedValueOnce({
            ...base,
            role: 'EDITOR',
            appPermissions: {
                ...base.appPermissions,
                admin: { ...base.appPermissions.admin, view: true, manage: false },
            },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await PUT_OWNER(ownerReq({ ownerUserId: 'u2' }), args as any);
        expect(res.status).toBe(403);
        expect(setOwnerMock).not.toHaveBeenCalled();
    });

    it('lets an ADMIN name an owner, and passes exactly the id', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('ADMIN'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await PUT_OWNER(ownerReq({ ownerUserId: 'u2' }), args as any);
        expect(res.status).toBe(200);
        expect(setOwnerMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-A' }), 'conn_1', 'u2');
    });

    it('accepts null, which clears the owner', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('ADMIN'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await PUT_OWNER(ownerReq({ ownerUserId: null }), args as any);
        expect(res.status).toBe(200);
        expect(setOwnerMock).toHaveBeenCalledWith(expect.anything(), 'conn_1', null);
    });

    it('refuses a field the route does not declare, so the PUT cannot reach the rest of the row', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('ADMIN'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await PUT_OWNER(ownerReq({ ownerUserId: 'u2', isEnabled: true }), args as any);
        expect(res.status).toBe(400);
        expect(setOwnerMock).not.toHaveBeenCalled();
    });

    it('declares admin.manage in ROUTE_PERMISSIONS for the owner path', () => {
        const rule = resolveRoutePermission('/api/t/acme/admin/integrations/conn_1/owner', 'PUT');
        expect(rule?.permission).toBe('admin.manage');
    });
});
