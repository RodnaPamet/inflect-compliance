/**
 * A workspace the Microsoft Entra ID group gate refused at sign-in stays
 * refused for the session, at every DB-backed gate (#4869).
 *
 * The refusal used to live only in the token's `memberships[]`, which the jwt
 * callback re-reads from the database every five minutes, so the refused
 * workspace came back. It is now the session's `entraGateDeniedTenantIds`,
 * and these gates read it:
 *
 *   - `getTenantCtx` / `getLegacyCtx` — every tenant API route;
 *   - `getTenantServerContext` — the tenant layout, every tenant page.
 *
 * Each refusal is paired with the same call admitting the workspace the gate
 * did not refuse, so a gate that refused everything would fail too.
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

// The account is an active member of both: only the refusal can refuse.
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

import { getLegacyCtx, getTenantCtx } from '@/app-layer/context';
import { getTenantServerContext } from '@/lib/server/tenant-context.server';
import { ENTRA_GATE_REFUSAL } from '@/lib/auth/entra-gate-scope';

function session(entraGateDeniedTenantIds: string[] | undefined, tenantId = 'tenant-a') {
    sessionMock.mockResolvedValue({
        userId: 'user-1',
        tenantId,
        email: 'member@example.com',
        role: 'ADMIN',
        ssoTenantId: null,
        signInMethod: 'oauth',
        entraGateDeniedTenantIds,
    });
}

beforeEach(() => sessionMock.mockReset());

describe('tenant API context', () => {
    it('refuses the workspace the gate refused, and admits the other', async () => {
        session(['tenant-b']);
        await expect(getTenantCtx({ tenantSlug: 'beta' })).rejects.toMatchObject({
            status: 403,
            message: ENTRA_GATE_REFUSAL,
        });
        await expect(getTenantCtx({ tenantSlug: 'alpha' })).resolves.toMatchObject({ tenantId: 'tenant-a' });
    });

    it('admits every workspace to a session with no refusal, or minted before the claim', async () => {
        session([]);
        await expect(getTenantCtx({ tenantSlug: 'beta' })).resolves.toMatchObject({ tenantId: 'tenant-b' });
        session(undefined);
        await expect(getTenantCtx({ tenantSlug: 'beta' })).resolves.toMatchObject({ tenantId: 'tenant-b' });
    });

    it('refuses on the legacy path that resolves the workspace from the session', async () => {
        session(['tenant-b'], 'tenant-b');
        await expect(getLegacyCtx()).rejects.toMatchObject({ status: 403 });
        session(['tenant-b'], 'tenant-a');
        await expect(getLegacyCtx()).resolves.toMatchObject({ tenantId: 'tenant-a' });
    });
});

describe('tenant page context (the tenant layout)', () => {
    const page = (tenantSlug: string, entraGateDeniedTenantIds: string[] | undefined) =>
        getTenantServerContext({
            tenantSlug,
            userId: 'user-1',
            ssoTenantId: null,
            signInMethod: 'oauth',
            entraGateDeniedTenantIds,
        });

    it('refuses the workspace the gate refused, and admits the other', async () => {
        await expect(page('beta', ['tenant-b'])).rejects.toMatchObject({ status: 403 });
        await expect(page('alpha', ['tenant-b'])).resolves.toMatchObject({ tenant: { id: 'tenant-a' } });
    });

    it('admits every workspace to a session with no refusal', async () => {
        await expect(page('beta', undefined)).resolves.toMatchObject({ tenant: { id: 'tenant-b' } });
    });
});
