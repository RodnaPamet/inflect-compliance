/**
 * FINDINGS TAKE KEYS OF THEIR OWN (#4535, owner decision 2026-10-30).
 *
 * Findings were the one register with no permission key: the routes relied on
 * the usecases' coarse `assertCanRead` / `assertCanWrite`, so a custom role
 * could not be given or refused findings apart from its base role, and a
 * refusal wrote no `AUTHZ_DENIED` row.
 *
 * What this file holds, against the real route handlers and the real
 * `requirePermission` / `assertPermission`:
 *
 *   1. the defaults REPRODUCE the coarse tiers, so no built-in role moves;
 *   2. every findings route — the tenant pair and their flat legacy twins —
 *      admits exactly the roles its key admits, and refuses anyone else with
 *      an `AUTHZ_DENIED` row before the usecase runs;
 *   3. a custom role is told apart from its base by the key alone;
 *   4. API key scopes reach the keys the way the neighbouring registers' do;
 *   5. the declarative route map records each gate.
 */
import { strictMock } from '../helpers/strict-mock';

// `computePermissions` sits beside the tenant resolver, which imports Prisma.
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

const ctxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: () => ctxMock(),
    getLegacyCtx: () => ctxMock(),
}));

const auditSpy = jest.fn(async (_entry: unknown) => ({ recorded: 'chain' as const, auditId: 'audit-x' }));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (entry: unknown) => auditSpy(entry),
    }),
);

const usecase = {
    listFindings: jest.fn(async () => []),
    getFinding: jest.fn(async () => ({ id: 'f-1' })),
    createFinding: jest.fn(async () => ({ id: 'f-1' })),
    updateFinding: jest.fn(async () => ({ id: 'f-1' })),
};
jest.mock('@/app-layer/usecases/finding', () => ({
    listFindings: (...a: unknown[]) => (usecase.listFindings as jest.Mock)(...a),
    getFinding: (...a: unknown[]) => (usecase.getFinding as jest.Mock)(...a),
    createFinding: (...a: unknown[]) => (usecase.createFinding as jest.Mock)(...a),
    updateFinding: (...a: unknown[]) => (usecase.updateFinding as jest.Mock)(...a),
}));

import { NextRequest } from 'next/server';
import { Role } from '@prisma/client';

import * as tenantList from '@/app/api/t/[tenantSlug]/findings/route';
import * as tenantOne from '@/app/api/t/[tenantSlug]/findings/[id]/route';
import * as legacyList from '@/app/api/findings/route';
import * as legacyOne from '@/app/api/findings/[id]/route';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';
import { scopesToPermissions } from '@/lib/auth/api-key-auth';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import type { RequestContext } from '@/app-layer/types';

import { makeRequestContext } from '../helpers/make-context';

type Handler = (req: NextRequest, args: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Key = 'view' | 'create' | 'edit';

const BODY = { title: 'Access not reviewed', severity: 'HIGH', type: 'NONCONFORMITY' };

interface RouteCase {
    name: string;
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    handler: Handler;
    params: Record<string, string>;
    body?: unknown;
    key: Key;
    usecase: keyof typeof usecase;
}

const ROUTES: RouteCase[] = [
    { name: 'GET /t/…/findings', method: 'GET', path: '/api/t/acme/findings', handler: tenantList.GET as unknown as Handler, params: { tenantSlug: 'acme' }, key: 'view', usecase: 'listFindings' },
    { name: 'POST /t/…/findings', method: 'POST', path: '/api/t/acme/findings', handler: tenantList.POST as unknown as Handler, params: { tenantSlug: 'acme' }, body: BODY, key: 'create', usecase: 'createFinding' },
    { name: 'GET /t/…/findings/:id', method: 'GET', path: '/api/t/acme/findings/f-1', handler: tenantOne.GET as unknown as Handler, params: { tenantSlug: 'acme', id: 'f-1' }, key: 'view', usecase: 'getFinding' },
    { name: 'PUT /t/…/findings/:id', method: 'PUT', path: '/api/t/acme/findings/f-1', handler: tenantOne.PUT as unknown as Handler, params: { tenantSlug: 'acme', id: 'f-1' }, body: { status: 'IN_PROGRESS' }, key: 'edit', usecase: 'updateFinding' },
    { name: 'GET /findings (legacy)', method: 'GET', path: '/api/findings', handler: legacyList.GET as unknown as Handler, params: {}, key: 'view', usecase: 'listFindings' },
    { name: 'POST /findings (legacy)', method: 'POST', path: '/api/findings', handler: legacyList.POST as unknown as Handler, params: {}, body: BODY, key: 'create', usecase: 'createFinding' },
    { name: 'GET /findings/:id (legacy)', method: 'GET', path: '/api/findings/f-1', handler: legacyOne.GET as unknown as Handler, params: { id: 'f-1' }, key: 'view', usecase: 'getFinding' },
    { name: 'PUT /findings/:id (legacy)', method: 'PUT', path: '/api/findings/f-1', handler: legacyOne.PUT as unknown as Handler, params: { id: 'f-1' }, body: { status: 'IN_PROGRESS' }, key: 'edit', usecase: 'updateFinding' },
];

async function call(route: RouteCase, ctx: RequestContext): Promise<Response> {
    ctxMock.mockResolvedValue(ctx);
    const req = new NextRequest(`http://localhost${route.path}`, {
        method: route.method,
        ...(route.body !== undefined
            ? { body: JSON.stringify(route.body), headers: { 'content-type': 'application/json' } }
            : {}),
    });
    return route.handler(req, { params: Promise.resolve(route.params) });
}

function withFindings(role: Role, keys: Partial<PermissionSet['findings']>): RequestContext {
    const base = makeRequestContext(role);
    return makeRequestContext(role, {
        appPermissions: { ...base.appPermissions, findings: { ...base.appPermissions.findings, ...keys } },
    });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('the defaults reproduce the coarse tiers, so no built-in role moves', () => {
    it.each(Object.values(Role))('%s', (role) => {
        const coarse = computePermissions(role);
        expect(getPermissionsForRole(role).findings).toEqual({
            view: coarse.canRead,
            create: coarse.canWrite,
            edit: coarse.canWrite,
        });
    });
});

describe.each(ROUTES)('$name takes findings.$key', (route) => {
    it.each(Object.values(Role))('%s', async (role) => {
        const res = await call(route, makeRequestContext(role));
        const held = getPermissionsForRole(role).findings[route.key];
        if (held) {
            expect(res.status).toBeLessThan(300);
            expect(usecase[route.usecase]).toHaveBeenCalledTimes(1);
            expect(auditSpy).not.toHaveBeenCalled();
        } else {
            expect(res.status).toBe(403);
            expect(usecase[route.usecase]).not.toHaveBeenCalled();
            expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'AUTHZ_DENIED' }));
        }
    });

    it('a custom role on an ADMIN base without the key is refused, with an AUTHZ_DENIED row', async () => {
        const res = await call(route, withFindings('ADMIN', { [route.key]: false }));
        expect(res.status).toBe(403);
        expect(usecase[route.usecase]).not.toHaveBeenCalled();
        expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'AUTHZ_DENIED' }));
    });

    it('…and with it, gets through to the usecase', async () => {
        const res = await call(route, withFindings('ADMIN', { [route.key]: true }));
        expect(res.status).toBeLessThan(300);
        expect(usecase[route.usecase]).toHaveBeenCalledTimes(1);
    });
});

describe('API key scopes reach the findings keys as the neighbouring registers do', () => {
    it('findings:read grants view only, findings:write create and edit', () => {
        expect(scopesToPermissions(['findings:read']).findings).toEqual({ view: true, create: false, edit: false });
        expect(scopesToPermissions(['findings:write']).findings).toEqual({ view: false, create: true, edit: true });
        expect(scopesToPermissions(['findings:*']).findings).toEqual({ view: true, create: true, edit: true });
    });

    it('a scope for another register grants no findings key — hence the migration for keys that predate them', () => {
        expect(scopesToPermissions(['controls:write']).findings).toEqual({ view: false, create: false, edit: false });
    });

    it('a `*` key holds every findings key', () => {
        expect(scopesToPermissions(['*']).findings).toEqual({ view: true, create: true, edit: true });
    });
});

describe('the route map records each gate', () => {
    it.each([
        ['/api/t/acme/findings', 'GET', 'findings.view'],
        ['/api/t/acme/findings', 'POST', 'findings.create'],
        ['/api/t/acme/findings/f-1', 'GET', 'findings.view'],
        ['/api/t/acme/findings/f-1', 'PUT', 'findings.edit'],
    ])('%s %s → %s', (path, method, key) => {
        expect(resolveRoutePermission(path, method)?.permission).toEqual(key);
    });

    it('converting a vulnerability into a finding asks findings.create too', () => {
        expect(resolveRoutePermission('/api/t/acme/vulnerabilities/v-1/convert-to-finding', 'POST')?.permission).toEqual([
            'assets.edit',
            'findings.create',
        ]);
    });
});
