/**
 * A session opened by single sign-on reaches only the tenant whose identity
 * provider opened it — at every DB-backed gate, not just at the edge.
 *
 * A tenant's identity provider is configured by that tenant's admin and can
 * assert any email address. Its session therefore vouches for the person in
 * that tenant alone (`src/lib/auth/sso-session.ts`). The session's claims are
 * already scoped, so the edge refuses other tenants
 * (tests/unit/sso-handoff-session.test.ts); this file holds the gates that
 * read memberships from the database, which would otherwise admit any tenant
 * the account belongs to:
 *
 *   - `getTenantCtx` / `getLegacyCtx` — every tenant API route;
 *   - `getTenantServerContext` — the tenant layout, every tenant page;
 *   - `getOrgCtx` / `getOrgServerContext` — organization APIs and pages, which
 *     an SSO session never reaches.
 *
 * Each case pairs the refusal with the same call succeeding for the SSO tenant
 * and for a session that did not come from SSO, so a gate that refused
 * everything would fail too.
 */

const sessionMock = jest.fn();

jest.mock('@/lib/auth', () => ({
    __esModule: true,
    getSessionOrThrow: () => sessionMock(),
}));

const TENANTS: Record<string, { id: string; slug: string }> = {
    alpha: { id: 'tenant-a', slug: 'alpha' },
    beta: { id: 'tenant-b', slug: 'beta' },
};

// The account is an active member of both tenants: only the scope can refuse.
jest.mock('@/lib/tenant-context', () => {
    const actual = jest.requireActual('@/lib/tenant-context');
    return {
        ...actual,
        resolveTenantContext: jest.fn(async (params: { tenantSlug?: string; tenantId?: string }) => {
            const tenant = params.tenantSlug
                ? TENANTS[params.tenantSlug]
                : Object.values(TENANTS).find((t) => t.id === params.tenantId);
            return {
                tenant: { ...tenant, name: tenant!.slug, currencySymbol: '€' },
                membership: { role: 'ADMIN', status: 'ACTIVE' },
                role: 'ADMIN',
                customRole: null,
                permissions: actual.computePermissions('ADMIN'),
                appPermissions: {},
            };
        }),
    };
});

jest.mock('@/lib/prisma', () => {
    const prisma = {
        tenantSecuritySettings: { findUnique: jest.fn(async () => null) },
        organization: { findUnique: jest.fn(async () => ({ id: 'org-o', slug: 'omega', name: 'Omega' })) },
        orgMembership: { findUnique: jest.fn(async () => ({ role: 'ORG_ADMIN' })) },
        // No workspace here enforces SSO; that rule has its own tests.
        tenantIdentityProvider: { findMany: jest.fn(async () => []) },
    };
    return { __esModule: true, default: prisma, prisma };
});

jest.mock('@/lib/observability/context', () => ({
    __esModule: true,
    mergeRequestContext: () => undefined,
    getRequestContext: () => null,
    setRequestContext: () => undefined,
}));

import { getLegacyCtx, getOrgCtx, getTenantCtx } from '@/app-layer/context';
import { getTenantServerContext } from '@/lib/server/tenant-context.server';
import { getOrgServerContext } from '@/lib/server/org-context.server';

function session(ssoTenantId: string | null, tenantId = 'tenant-b') {
    sessionMock.mockResolvedValue({
        userId: 'user-1',
        tenantId,
        email: 'member@example.com',
        role: 'ADMIN',
        ssoTenantId,
    });
}

beforeEach(() => sessionMock.mockReset());

describe('tenant API context', () => {
    it('refuses another tenant to a session opened by SSO', async () => {
        session('tenant-b');
        await expect(getTenantCtx({ tenantSlug: 'alpha' })).rejects.toMatchObject({ status: 403 });
    });

    it('admits the SSO tenant, and any tenant to a session not opened by SSO', async () => {
        session('tenant-b');
        await expect(getTenantCtx({ tenantSlug: 'beta' })).resolves.toMatchObject({ tenantId: 'tenant-b' });
        session(null);
        await expect(getTenantCtx({ tenantSlug: 'alpha' })).resolves.toMatchObject({ tenantId: 'tenant-a' });
    });

    it('treats any scope string as a scope, so a malformed one refuses rather than admits', async () => {
        session('');
        await expect(getTenantCtx({ tenantSlug: 'beta' })).rejects.toMatchObject({ status: 403 });
    });

    it('refuses on the legacy path that resolves the tenant from the session', async () => {
        session('tenant-b', 'tenant-a');
        await expect(getLegacyCtx()).rejects.toMatchObject({ status: 403 });
        session('tenant-b', 'tenant-b');
        await expect(getLegacyCtx()).resolves.toMatchObject({ tenantId: 'tenant-b' });
    });
});

describe('tenant page context (the tenant layout)', () => {
    it('refuses another tenant to a session opened by SSO', async () => {
        await expect(
            getTenantServerContext({ tenantSlug: 'alpha', userId: 'user-1', ssoTenantId: 'tenant-b', signInMethod: 'sso' }),
        ).rejects.toMatchObject({ status: 403 });
    });

    it('admits the SSO tenant, and any tenant to a session not opened by SSO', async () => {
        await expect(
            getTenantServerContext({ tenantSlug: 'beta', userId: 'user-1', ssoTenantId: 'tenant-b', signInMethod: 'sso' }),
        ).resolves.toMatchObject({ tenant: { id: 'tenant-b' } });
        await expect(
            getTenantServerContext({ tenantSlug: 'alpha', userId: 'user-1', ssoTenantId: null, signInMethod: 'credentials' }),
        ).resolves.toMatchObject({ tenant: { id: 'tenant-a' } });
    });
});

describe('organization context', () => {
    it('is never reached by a session opened by SSO, member or not', async () => {
        session('tenant-b');
        await expect(getOrgCtx({ orgSlug: 'omega' })).rejects.toMatchObject({ status: 404 });
        await expect(
            getOrgServerContext({ orgSlug: 'omega', userId: 'user-1', ssoTenantId: 'tenant-b' }),
        ).rejects.toThrow('Organization not found or access not permitted');
    });

    it('is reached by the same member on a session not opened by SSO', async () => {
        session(null);
        await expect(getOrgCtx({ orgSlug: 'omega' })).resolves.toMatchObject({ organizationId: 'org-o' });
        await expect(
            getOrgServerContext({ orgSlug: 'omega', userId: 'user-1', ssoTenantId: null }),
        ).resolves.toMatchObject({ organization: { id: 'org-o' } });
    });
});
