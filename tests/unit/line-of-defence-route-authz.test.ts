/**
 * `PUT /api/t/:slug/admin/members/:membershipId/line-of-defence` (#3675) —
 * the ROUTE's gate, driven end to end with the real `requirePermission`.
 *
 * Only an OWNER sets a member's line of defence. The route's literal
 * `requirePermission('admin.owner_management')` is the gate whose refusal
 * writes the hash-chained `AUTHZ_DENIED` row: ADMIN is denied the key
 * explicitly and AI_ADMIN never had it, so both get a generic 403, the denial
 * is audited, and the usecase is never reached. The usecase's own checks
 * (built-in role OWNER, not one's own membership, a person) are proved against
 * real rows in `tests/integration/membership-line-of-defence.test.ts`.
 */
import { strictMock } from '../helpers/strict-mock';

const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

const auditSpy = jest.fn(async () => ({ recorded: 'chain' as const, auditId: 'audit-x' }));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (...args: unknown[]) => auditSpy(...(args as [])),
        appendAuditEntry: jest.fn(async () => ({ id: 'audit-x', entryHash: 'h', previousHash: null })),
    }),
);

const setLineMock = jest.fn(async () => ({
    membershipId: 'm-2',
    userId: 'user-2',
    lineOfDefence: 'SECOND',
    previousLineOfDefence: null,
    changed: true,
    independenceFindingIds: [],
}));
jest.mock('@/app-layer/usecases/membership-line-of-defence', () => ({
    setMembershipLineOfDefence: (...args: unknown[]) => setLineMock(...(args as [])),
}));

import { NextRequest } from 'next/server';

import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { makeRequestContext } from '../helpers/make-context';

const URL = 'http://localhost/api/t/acme/admin/members/m-2/line-of-defence';
const routeArgs = { params: Promise.resolve({ tenantSlug: 'acme', membershipId: 'm-2' }) };

async function put(role: string) {
    getTenantCtxMock.mockResolvedValue(makeRequestContext(role, { tenantId: 'tenant-1', userId: 'user-1' }));
    const { PUT } = await import('@/app/api/t/[tenantSlug]/admin/members/[membershipId]/line-of-defence/route');
    return PUT(
        new NextRequest(URL, {
            method: 'PUT',
            headers: new Headers({ 'content-type': 'application/json' }),
            body: JSON.stringify({ lineOfDefence: 'SECOND' }),
        }),
        routeArgs as never,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('only an OWNER can set a line of defence', () => {
    it.each(['ADMIN', 'AI_ADMIN', 'EDITOR', 'READER', 'AUDITOR'])(
        '%s is refused with a generic 403, the denial is audited, and the usecase is never reached',
        async (role) => {
            expect(getPermissionsForRole(role as never).admin.owner_management).toBe(false);
            const res = await put(role);
            expect(res.status).toBe(403);
            expect(JSON.stringify(await res.json())).not.toMatch(/owner_management/);
            expect(auditSpy).toHaveBeenCalledTimes(1);
            expect(setLineMock).not.toHaveBeenCalled();
        },
    );

    it('an OWNER reaches the usecase, with the membership id from the path and the body as sent', async () => {
        const res = await put('OWNER');
        expect(res.status).toBe(200);
        expect(setLineMock).toHaveBeenCalledTimes(1);
        expect(setLineMock).toHaveBeenCalledWith(
            expect.objectContaining({ role: 'OWNER' }),
            'm-2',
            { lineOfDefence: 'SECOND' },
        );
        expect(auditSpy).not.toHaveBeenCalled();
    });
});

describe('the route map records the key the handler enforces', () => {
    it('resolves admin.owner_management, not the members catch-all', () => {
        const rule = resolveRoutePermission('/api/t/acme/admin/members/m-2/line-of-defence', 'PUT');
        expect(rule?.permission).toBe('admin.owner_management');
        // The neighbour still resolves to the catch-all.
        expect(resolveRoutePermission('/api/t/acme/admin/members/m-2', 'PATCH')?.permission).toBe('admin.members');
    });
});
