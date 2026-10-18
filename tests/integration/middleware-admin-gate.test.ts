/* eslint-disable @typescript-eslint/no-explicit-any -- middleware test harness
 * mirrors tests/integration/middleware-mfa-gate.test.ts (NextRequest fixtures +
 * mocked rate-limiters + getToken). */
/**
 * #3701 — the edge admin gate judges a tenant admin path by the role the
 * session holds IN THAT TENANT, not by its primary (oldest) membership's role.
 *
 * Every assertion runs through the real `middleware()` export, because the
 * defect was which field the gate read, and only a request through the gate
 * shows which one it reads. The two cases the issue names come first; the rest
 * pin what must not move with them.
 */
import { NextRequest } from 'next/server';

jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
    isApiReadRateLimited: jest.fn().mockReturnValue(false),
    extractTenantSlug: jest.fn().mockReturnValue(null),
}));
jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));

import middleware from '../../src/middleware';
import { getToken } from 'next-auth/jwt';

const mockGetToken = getToken as jest.Mock;

type Role = 'OWNER' | 'ADMIN' | 'EDITOR' | 'READER' | 'AUDITOR';

/**
 * A session whose PRIMARY membership is `alpha` (the first entry, as
 * `src/auth.ts` mints it) and which also belongs to `beta`.
 */
function token(alphaRole: Role, betaRole: Role, extra: Record<string, unknown> = {}) {
    return {
        sub: 'user-1',
        userId: 'user-1',
        role: alphaRole,
        mfaPending: false,
        tenantId: 'tenant-alpha',
        tenantSlug: 'alpha',
        memberships: [
            { slug: 'alpha', role: alphaRole, tenantId: 'tenant-alpha' },
            { slug: 'beta', role: betaRole, tenantId: 'tenant-beta' },
        ],
        membershipsTruncated: false,
        orgMemberships: [],
        ...extra,
    };
}

function req(method: string, pathname: string, headers: Record<string, string> = {}) {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method,
        headers: new Headers(headers),
    });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('edge admin gate — the role is the one held in the URL tenant (#3701)', () => {
    it('admits an OWNER of this tenant whose primary membership is READER', async () => {
        mockGetToken.mockResolvedValue(token('READER', 'OWNER'));
        const res = await middleware(req('GET', '/api/t/beta/admin/members'), {} as any);
        expect(res.status).toBe(200);
    });

    it('refuses a READER of this tenant whose primary membership is OWNER', async () => {
        mockGetToken.mockResolvedValue(token('OWNER', 'READER'));
        const res = await middleware(req('GET', '/api/t/beta/admin/members'), {} as any);
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({ error: 'Admin access required' });
    });

    it('admits an ADMIN of this tenant whose primary membership is EDITOR', async () => {
        mockGetToken.mockResolvedValue(token('EDITOR', 'ADMIN'));
        const res = await middleware(req('POST', '/api/t/beta/admin/agents/a-1/ownership-transfer', {
            'sec-fetch-site': 'same-origin',
        }), {} as any);
        expect(res.status).toBe(200);
    });

    it('still judges the primary tenant by its own role', async () => {
        mockGetToken.mockResolvedValue(token('OWNER', 'READER'));
        expect((await middleware(req('GET', '/api/t/alpha/admin/members'), {} as any)).status).toBe(200);

        mockGetToken.mockResolvedValue(token('READER', 'OWNER'));
        const res = await middleware(req('GET', '/api/t/alpha/admin/members'), {} as any);
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({ error: 'Admin access required' });
    });
});

describe('edge admin gate — what must not move with it', () => {
    it('refuses a cross-site admin write from an admin of this tenant', async () => {
        mockGetToken.mockResolvedValue(token('READER', 'OWNER'));
        const res = await middleware(req('POST', '/api/t/beta/admin/members', {
            'sec-fetch-site': 'cross-site',
        }), {} as any);
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({ error: 'Cross-site admin requests are not allowed' });
    });

    it('a tenant missing from a complete claim is refused by the tenant gate, even for a primary OWNER', async () => {
        mockGetToken.mockResolvedValue(token('OWNER', 'OWNER'));
        const res = await middleware(req('GET', '/api/t/gamma/admin/members'), {} as any);
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({ error: 'cross_tenant_access_denied' });
    });

    it('a tenant missing from a TRUNCATED claim is deferred to the server gate, whatever the primary role', async () => {
        // The membership may be one that did not fit in the cookie. Refusing at
        // the edge would lock out a legitimate member; the handler's
        // `requirePermission` is the authority.
        mockGetToken.mockResolvedValue(token('READER', 'READER', { membershipsTruncated: true }));
        const res = await middleware(req('GET', '/api/t/gamma/admin/members'), {} as any);
        expect(res.status).toBe(200);
    });

    it('a cross-site admin write to a deferred tenant is still refused', async () => {
        mockGetToken.mockResolvedValue(token('READER', 'READER', { membershipsTruncated: true }));
        const res = await middleware(req('DELETE', '/api/t/gamma/admin/members/m-1', {
            'sec-fetch-site': 'cross-site',
        }), {} as any);
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({ error: 'Cross-site admin requests are not allowed' });
    });

    it('an admin PAGE for a non-admin here still proceeds to the layout guard, rather than redirecting', async () => {
        mockGetToken.mockResolvedValue(token('OWNER', 'READER'));
        const res = await middleware(req('GET', '/t/beta/admin/members'), {} as any);
        expect(res.status).toBe(200);
        expect(res.headers.get('location')).toBeNull();
    });

    it('a non-admin tenant path is not touched by the admin gate', async () => {
        mockGetToken.mockResolvedValue(token('OWNER', 'READER'));
        const res = await middleware(req('GET', '/api/t/beta/risks'), {} as any);
        expect(res.status).toBe(200);
    });
});
