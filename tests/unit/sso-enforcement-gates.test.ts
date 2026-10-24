/**
 * "Enforce SSO" at the DB-backed gates, and the rule for turning it on.
 *
 * The session's claims already drop a workspace that enforcement does not
 * admit, so the edge refuses it (tests/unit/sso-enforcement-sign-in.test.ts).
 * The gates that read memberships from the database — every tenant API route
 * (`getTenantCtx`, `getLegacyCtx`) and every tenant page
 * (`getTenantServerContext`) — must refuse it too, or a session minted before
 * enforcement was switched on would keep working until its claims refresh.
 *
 * And break-glass counts OWNERs: `setTenantSsoEnforced` refuses to switch
 * enforcement on unless somebody could still get in with a password, and it
 * used to count ADMINs alone, so a workspace run by its OWNER could never
 * enforce SSO at all.
 */
const sessionMock = jest.fn();
jest.mock('@/lib/auth', () => ({
    __esModule: true,
    getSessionOrThrow: () => sessionMock(),
}));

let membershipRole = 'READER';
jest.mock('@/lib/tenant-context', () => {
    const actual = jest.requireActual('@/lib/tenant-context');
    return {
        ...actual,
        resolveTenantContext: jest.fn(async () => ({
            tenant: { id: 'tenant-b', slug: 'beta', name: 'Beta', currencySymbol: '€' },
            membership: { role: membershipRole, status: 'ACTIVE' },
            role: membershipRole,
            customRole: null,
            permissions: actual.computePermissions(membershipRole),
            appPermissions: {},
        })),
    };
});

const enforcedTenants: string[] = [];
let passwordHash: string | null = '$2b$10$hash';
const breakGlassMembers: { role: string; user: { passwordHash: string | null } }[] = [];
jest.mock('@/lib/prisma', () => {
    const prisma = {
        tenantIdentityProvider: {
            findMany: jest.fn(async ({ where }: { where: { tenantId: { in: string[] } } }) =>
                enforcedTenants.filter((t) => where.tenantId.in.includes(t)).map((tenantId) => ({ tenantId })),
            ),
        },
        user: { findUnique: jest.fn(async () => ({ passwordHash })) },
        tenantMembership: {
            findMany: jest.fn(async ({ where }: { where: { role: { in: string[] } } }) =>
                breakGlassMembers.filter((m) => where.role.in.includes(m.role)),
            ),
        },
        tenantSecuritySettings: { findUnique: jest.fn(async () => null) },
    };
    return { __esModule: true, default: prisma, prisma };
});
jest.mock('@/app-layer/repositories/SsoConfigRepository', () => ({
    findById: jest.fn(async () => ({ id: 'idp-1', tenantId: 'tenant-b' })),
    setEnforced: jest.fn(async () => ({ id: 'idp-1', isEnforced: true })),
}));
jest.mock('@/lib/observability/context', () => ({
    __esModule: true,
    mergeRequestContext: () => undefined,
    getRequestContext: () => null,
    setRequestContext: () => undefined,
}));

import { getLegacyCtx, getTenantCtx } from '@/app-layer/context';
import { getTenantServerContext } from '@/lib/server/tenant-context.server';
import { setTenantSsoEnforced } from '@/app-layer/usecases/sso';
import { SSO_REQUIRED_REFUSAL } from '@/lib/auth/sso-enforcement';
import { makeRequestContext } from '../helpers/make-context';

function session(signInMethod: 'credentials' | 'oauth' | 'sso', ssoTenantId: string | null = null) {
    sessionMock.mockResolvedValue({
        userId: 'user-1', tenantId: 'tenant-b', email: 'm@example.com', role: membershipRole,
        ssoTenantId, signInMethod,
    });
}

beforeEach(() => {
    enforcedTenants.length = 0;
    enforcedTenants.push('tenant-b');
    passwordHash = '$2b$10$hash';
    membershipRole = 'READER';
    breakGlassMembers.length = 0;
});

describe('the tenant API and page gates', () => {
    it('refuse a password session that is not break-glass', async () => {
        session('credentials');
        await expect(getTenantCtx({ tenantSlug: 'beta' })).rejects.toMatchObject({ status: 403, message: SSO_REQUIRED_REFUSAL });
        await expect(getLegacyCtx()).rejects.toMatchObject({ status: 403 });
        await expect(
            getTenantServerContext({ tenantSlug: 'beta', userId: 'user-1', ssoTenantId: null, signInMethod: 'credentials' }),
        ).rejects.toMatchObject({ status: 403 });
    });

    it.each(['OWNER', 'ADMIN'])('admit a break-glass %s signed in with their password', async (role) => {
        membershipRole = role;
        session('credentials');
        await expect(getTenantCtx({ tenantSlug: 'beta' })).resolves.toMatchObject({ tenantId: 'tenant-b' });
        await expect(
            getTenantServerContext({ tenantSlug: 'beta', userId: 'user-1', ssoTenantId: null, signInMethod: 'credentials' }),
        ).resolves.toMatchObject({ tenant: { id: 'tenant-b' } });
    });

    it('refuse that OWNER when they have no password, or came in through Google', async () => {
        membershipRole = 'OWNER';
        passwordHash = null;
        session('credentials');
        await expect(getTenantCtx({ tenantSlug: 'beta' })).rejects.toMatchObject({ status: 403 });

        passwordHash = '$2b$10$hash';
        session('oauth');
        await expect(getTenantCtx({ tenantSlug: 'beta' })).rejects.toMatchObject({ status: 403 });
    });

    it("admit the workspace's own SSO", async () => {
        session('sso', 'tenant-b');
        await expect(getTenantCtx({ tenantSlug: 'beta' })).resolves.toMatchObject({ tenantId: 'tenant-b' });
    });

    it('treat a session minted before the sign-in method was recorded as no password sign-in', async () => {
        membershipRole = 'OWNER';
        sessionMock.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant-b', email: 'm@example.com', role: 'OWNER' });
        await expect(getTenantCtx({ tenantSlug: 'beta' })).rejects.toMatchObject({ status: 403 });
    });

    it('change nothing for a workspace that does not enforce SSO', async () => {
        enforcedTenants.length = 0;
        session('oauth');
        await expect(getTenantCtx({ tenantSlug: 'beta' })).resolves.toMatchObject({ tenantId: 'tenant-b' });
    });
});

describe('turning enforcement on', () => {
    const admin = () => makeRequestContext('OWNER', { tenantId: 'tenant-b' });

    it('is allowed for a workspace whose only way back in is its OWNER with a password', async () => {
        breakGlassMembers.push({ role: 'OWNER', user: { passwordHash: '$2b$10$hash' } });
        await expect(setTenantSsoEnforced(admin(), 'idp-1', true)).resolves.toMatchObject({ isEnforced: true });
    });

    it('is refused when no OWNER or ADMIN could still sign in with a password', async () => {
        breakGlassMembers.push({ role: 'OWNER', user: { passwordHash: null } });
        breakGlassMembers.push({ role: 'EDITOR', user: { passwordHash: '$2b$10$hash' } });
        await expect(setTenantSsoEnforced(admin(), 'idp-1', true)).rejects.toThrow(/break-glass/i);
    });
});
