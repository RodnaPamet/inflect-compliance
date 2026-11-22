/**
 * A workspace past the session's capped membership claim is asked for its MFA
 * policy by the server tenant gate (`getTenantCtx`), because sign-in never asked
 * it and the edge cannot hold it. Until THIS session passes that workspace's
 * challenge, an API request is refused with the edge's own 403 and a page is
 * sent to the workspace's challenge. The MFA challenge and enrolment APIs stay
 * reachable. A workspace in the claim costs no query.
 */
const sessionMock = jest.fn();
jest.mock('@/lib/auth', () => ({
    __esModule: true,
    getSessionOrThrow: () => sessionMock(),
}));

const TENANTS: Record<string, { id: string; slug: string }> = {
    alpha: { id: 'tenant-a', slug: 'alpha' },
    far: { id: 'tenant-far', slug: 'far' },
};
jest.mock('@/lib/tenant-context', () => {
    const actual = jest.requireActual('@/lib/tenant-context');
    return {
        ...actual,
        resolveTenantContext: jest.fn(async (params: { tenantSlug?: string }) => {
            const tenant = TENANTS[params.tenantSlug!];
            return {
                tenant: { ...tenant, name: tenant.slug, currencySymbol: '€' },
                membership: { role: 'EDITOR', status: 'ACTIVE' },
                role: 'EDITOR',
                customRole: null,
                permissions: actual.computePermissions('EDITOR'),
                appPermissions: {},
            };
        }),
    };
});

const db = { policies: {} as Record<string, string>, passes: [] as string[] };
jest.mock('@/lib/prisma', () => {
    const prisma = {
        tenantSecuritySettings: {
            findUnique: jest.fn(async () => null),
            findMany: jest.fn(async ({ where }: { where: { tenantId: { in: string[] } } }) =>
                where.tenantId.in.filter((id) => db.policies[id]).map((tenantId) => ({ tenantId, mfaPolicy: db.policies[tenantId] })),
            ),
        },
        userMfaEnrollment: { findMany: jest.fn(async () => []) },
        userSession: {
            findUnique: jest.fn(async () => ({ userId: 'user-1', mfaPassedTenantIds: db.passes })),
        },
        tenantIdentityProvider: { findMany: jest.fn(async () => []) },
    };
    return { __esModule: true, default: prisma, prisma };
});
jest.mock('@/lib/security/session-tracker', () => ({
    currentSessionIdOf: jest.fn(async () => 'sess-1'),
    currentSessionIdFromCookies: jest.fn(async () => 'sess-1'),
}));
const redirectMock = jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
});
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirectMock(url) }));
jest.mock('@/lib/observability/context', () => ({
    __esModule: true,
    mergeRequestContext: () => undefined,
    getRequestContext: () => null,
    setRequestContext: () => undefined,
}));

import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { WORKSPACE_MFA_REQUIRED } from '@/lib/auth/workspace-mfa';
import prisma from '@/lib/prisma';

function session(claimed: string[] | undefined, pending: string[] = []) {
    sessionMock.mockResolvedValue({
        userId: 'user-1',
        tenantId: 'tenant-a',
        email: 'member@example.com',
        role: 'EDITOR',
        ssoTenantId: null,
        signInMethod: 'password',
        entraGateDeniedTenantIds: [],
        membershipTenantIds: claimed,
        mfaPendingTenantIds: pending,
    });
}
const api = (path: string) => new NextRequest(`http://localhost${path}`);

beforeEach(() => {
    sessionMock.mockReset();
    redirectMock.mockClear();
    db.policies = {};
    db.passes = [];
    (prisma.tenantSecuritySettings.findMany as jest.Mock).mockClear();
});

describe('a workspace past the capped claim', () => {
    it('is refused at the API while it wants a code this session has not given', async () => {
        db.policies = { 'tenant-far': 'REQUIRED' };
        session(['tenant-a']);
        await expect(getTenantCtx({ tenantSlug: 'far' }, api('/api/t/far/controls'))).rejects.toMatchObject({
            status: 403,
            message: WORKSPACE_MFA_REQUIRED,
        });
    });

    it('sends a page to the workspace challenge', async () => {
        db.policies = { 'tenant-far': 'REQUIRED' };
        session(['tenant-a']);
        await expect(getTenantCtx({ tenantSlug: 'far' })).rejects.toThrow(/NEXT_REDIRECT \/t\/far\/auth\/mfa/);
    });

    it('keeps the challenge and enrolment APIs reachable', async () => {
        db.policies = { 'tenant-far': 'REQUIRED' };
        session(['tenant-a']);
        await expect(
            getTenantCtx({ tenantSlug: 'far' }, api('/api/t/far/security/mfa/enroll/start')),
        ).resolves.toMatchObject({ tenantId: 'tenant-far' });
    });

    it('is admitted once this session passed its challenge', async () => {
        db.policies = { 'tenant-far': 'REQUIRED' };
        db.passes = ['tenant-far'];
        session(['tenant-a']);
        await expect(getTenantCtx({ tenantSlug: 'far' }, api('/api/t/far/controls'))).resolves.toMatchObject({
            tenantId: 'tenant-far',
        });
    });

    it('is admitted when it asks for no code', async () => {
        session(['tenant-a']);
        await expect(getTenantCtx({ tenantSlug: 'far' }, api('/api/t/far/controls'))).resolves.toMatchObject({
            tenantId: 'tenant-far',
        });
    });
});

describe('a workspace in the claim', () => {
    it('costs no query, and is admitted', async () => {
        db.policies = { 'tenant-a': 'REQUIRED' };
        session(['tenant-a', 'tenant-far']);
        await expect(getTenantCtx({ tenantSlug: 'far' }, api('/api/t/far/controls'))).resolves.toBeTruthy();
        expect(prisma.tenantSecuritySettings.findMany).not.toHaveBeenCalled();
    });

    it('is refused while it is pending for this session', async () => {
        session(['tenant-a', 'tenant-far'], ['tenant-far']);
        await expect(getTenantCtx({ tenantSlug: 'far' }, api('/api/t/far/controls'))).rejects.toMatchObject({
            status: 403,
        });
    });
});
