/* eslint-disable @typescript-eslint/no-explicit-any -- middleware test harness
 * mirrors tests/integration/middleware-public-reachability.test.ts (NextRequest
 * fixtures + mocked rate-limiters + getToken). */
/**
 * #2224 — a partner request through the REAL middleware with NO session cookie.
 *
 * `getToken()` reads `Authorization: Bearer`, JWE-decodes whatever it finds and
 * returns null on an `iflk_` key — so the edge 401'd the documented partner
 * flow before `tryApiKeyAuth` (wired into both context builders) ever ran.
 * `getToken` is mocked to return null here, which is EXACTLY what the real one
 * does with an API key in the header; the mock reproduces the condition, it
 * does not paper over it.
 *
 * The sibling file `middleware-public-reachability.test.ts` proves a cookieless
 * `/api/t/acme/risks` still 401s. That test sends no `Authorization` header at
 * all, so it says nothing about a Bearer request — this file is the missing
 * half, and the two together pin the narrowness of the fall-through.
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
jest.mock('next-auth/jwt', () => ({
    // What the real `getToken` returns for `Bearer iflk_…`: it tries to
    // JWE-decode the header value, throws, and catches to null.
    getToken: jest.fn().mockResolvedValue(null),
}));

import middleware from '../../src/middleware';
import { checkApiReadRateLimit } from '../../src/lib/rate-limit/apiReadRateLimit';

const KEY = `iflk_${'a1b2c3d4'.repeat(6)}`;

function req(method: string, pathname: string, headers: Record<string, string> = {}) {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method,
        headers: new Headers(headers),
    });
}

describe('middleware reachability — tenant API with an `iflk_` API key (#2224)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (checkApiReadRateLimit as jest.Mock).mockResolvedValue({ ok: true });
    });

    it.each([
        ['GET', '/api/t/acme/risks'],
        ['POST', '/api/t/acme/risks'],
        ['GET', '/api/t/acme/admin/api-keys'],
    ])('%s %s reaches the handler (not 401) with a key and no cookie', async (method, path) => {
        const res = await middleware(
            req(method, path, { authorization: `Bearer ${KEY}` }),
            {} as any,
        );
        expect(res.status).not.toBe(401);
        expect(res.status).toBe(200);
    });

    it('meters the key request at the edge, keyed per-key and not per-tenant', async () => {
        await middleware(
            req('GET', '/api/t/acme/risks', { authorization: `Bearer ${KEY}` }),
            {} as any,
        );
        const calls = (checkApiReadRateLimit as jest.Mock).mock.calls;
        // TWO buckets: this per-key one for fairness, plus an IP-only one for
        // containment (asserted in the next test). Was `toHaveLength(1)` when
        // only the per-key bucket existed.
        expect(calls).toHaveLength(2);
        const scope = calls[0][2] as string;
        expect(scope).toMatch(/^apikey:[0-9a-f]{8}$/);
        // Not the key, and not a truncation of it — the scope is logged at WARN
        // by the limiter on a 429.
        expect(scope).not.toContain(KEY.slice(0, 12));
    });

    it('ALSO meters an IP-only bucket — the per-key one bounds nothing for a flood', async () => {
        // The per-key bucket exists for fairness: partner keys behind one NAT
        // get independent budgets. It cannot bound an ATTACKER, because the
        // credential is the thing an attacker varies — a random `iflk_` per
        // request yields a fresh bucket every time.
        //
        // That matters more since this block started falling through: each such
        // request now reaches the App Router and burns a
        // `tenantApiKey.findUnique` before its 401, where previously it was a
        // free edge refusal. Block 0e sixty lines above writes down exactly
        // this reasoning ("the credential is the thing an attacker varies —
        // keying by it would hand every guess a fresh budget"); 0f must not
        // contradict it.
        await middleware(req('GET', '/api/t/acme/risks', { authorization: `Bearer ${KEY}` }), {} as never);

        const scopes = (checkApiReadRateLimit as jest.Mock).mock.calls.map((c) => c[2] as string);
        expect(scopes).toContain('apikey-ip');
        // And the per-key one is still there — this is an ADDITION, not a swap.
        expect(scopes.some((sc) => /^apikey:[0-9a-f]{8}$/.test(sc))).toBe(true);
    });

    it('a flood of DIFFERENT keys still shares one bucket', async () => {
        // The property the previous test's mechanism buys. Without the IP
        // bucket every one of these is a fresh budget and the flood is
        // unbounded.
        for (let i = 0; i < 5; i += 1) {
            const varied = `iflk_${String(i).padStart(48, 'a')}`;
            await middleware(req('GET', '/api/t/acme/risks', { authorization: `Bearer ${varied}` }), {} as never);
        }
        const scopes = (checkApiReadRateLimit as jest.Mock).mock.calls.map((c) => c[2] as string);
        const perKey = new Set(scopes.filter((sc) => /^apikey:/.test(sc)));
        const perIp = scopes.filter((sc) => sc === 'apikey-ip');
        expect(perKey.size).toBe(5);   // five distinct budgets — the flood's advantage
        expect(perIp).toHaveLength(5); // charged to ONE bucket five times — the containment
    });

    it('a throttled key gets the limiter 429, not the handler', async () => {
        (checkApiReadRateLimit as jest.Mock).mockResolvedValue({
            ok: false,
            response: new Response(null, { status: 429 }),
        });
        const res = await middleware(
            req('GET', '/api/t/acme/risks', { authorization: `Bearer ${KEY}` }),
            {} as any,
        );
        expect(res.status).toBe(429);
    });

    // ── The fall-through must not spread ──────────────────────────────
    //
    // It skips the JWT-derived edge gates, so anything it covers beyond the
    // documented partner surface is a hole. These are the paths a careless
    // widening would take with it.

    it.each([
        ['a flat authenticated API route', '/api/evidence'],
        ['the flat audit-log read', '/api/audit-log'],
        ['a flat admin route', '/api/admin/tenants'],
        ['an org-scoped route', '/api/org/acme/portfolio'],
    ])('%s is still 401 with a key and no cookie', async (_label, path) => {
        const res = await middleware(
            req('GET', path, { authorization: `Bearer ${KEY}` }),
            {} as any,
        );
        expect(res.status).toBe(401);
    });

    it.each([
        ['no Authorization header', undefined],
        ['a session-style JWT in the header', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x'],
        ['a device-agent token', 'Bearer icdt_testtoken123456'],
        ['Basic auth', 'Basic dXNlcjpwYXNz'],
    ])('the tenant API with %s is still 401', async (_label, authorization) => {
        const res = await middleware(
            req('GET', '/api/t/acme/risks', authorization ? { authorization } : {}),
            {} as any,
        );
        expect(res.status).toBe(401);
        expect(checkApiReadRateLimit).not.toHaveBeenCalled();
    });

    it('a tenant PAGE with a key header is still redirected to login', async () => {
        // Pages are a browser surface; a key must not make one reachable.
        const res = await middleware(
            req('GET', '/t/acme/dashboard', { authorization: `Bearer ${KEY}` }),
            {} as any,
        );
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toContain('/login');
    });
});
