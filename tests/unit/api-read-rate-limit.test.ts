/**
 * GAP-17: read-tier rate limit for tenant-scoped GET API routes.
 *
 * Two surfaces under test:
 *   1. `isApiReadRateLimited(method, pathname)` — match logic, the
 *      cheap predicate the middleware calls before doing any work.
 *   2. `checkApiReadRateLimit(req, userId, tenantSlug)` — the actual
 *      enforcement, exercised against the in-memory fallback (the
 *      Upstash path is the same logic from a calling-API perspective).
 */
import type { NextRequest } from 'next/server';

// ─── Stable env BEFORE the module loads. ───
//
// `apiReadRateLimit.ts` reads `env.RATE_LIMIT_MODE` and the bypass
// gates at first invocation. Forcing memory mode here pins the
// limiter to the in-process Map so tests don't try to reach
// Upstash and so we can drive it deterministically.
process.env.RATE_LIMIT_MODE = 'memory';
delete process.env.RATE_LIMIT_ENABLED;
delete process.env.AUTH_TEST_MODE;
delete process.env.NEXT_TEST_MODE;

import {
    isApiReadRateLimited,
    extractTenantSlug,
    checkApiReadRateLimit,
    _clearApiReadRateLimitMemory,
} from '@/lib/rate-limit/apiReadRateLimit';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';

function fakeReq(headers: Record<string, string> = {}): NextRequest {
    // We only need the .headers.get() shape — NextRequest in tests
    // is awkward to construct. A minimal mock that matches the
    // signature is fine for our purposes.
    return {
        headers: {
            get: (name: string) => headers[name.toLowerCase()] ?? null,
        },
    } as unknown as NextRequest;
}

describe('isApiReadRateLimited (match logic)', () => {
    it('matches GET on /api/t/<slug>/<resource>', () => {
        expect(isApiReadRateLimited('GET', '/api/t/acme-corp/controls')).toBe(true);
        expect(isApiReadRateLimited('GET', '/api/t/acme-corp/risks?limit=50')).toBe(true);
        expect(isApiReadRateLimited('GET', '/api/t/acme-corp/evidence/abc123')).toBe(true);
    });

    it('does NOT match non-GET methods (mutations have their own tier)', () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
            expect(isApiReadRateLimited(method, '/api/t/acme-corp/controls')).toBe(false);
        }
    });

    it('does NOT match GETs outside /api/t/', () => {
        expect(isApiReadRateLimited('GET', '/api/auth/csrf')).toBe(false);
        expect(isApiReadRateLimited('GET', '/api/admin/tenants')).toBe(false);
        expect(isApiReadRateLimited('GET', '/api/org/acme/portfolio')).toBe(false);
        expect(isApiReadRateLimited('GET', '/dashboard')).toBe(false);
        expect(isApiReadRateLimited('GET', '/')).toBe(false);
    });

    it('excludes /api/health (and the modern livez/readyz aliases)', () => {
        expect(isApiReadRateLimited('GET', '/api/health')).toBe(false);
        expect(isApiReadRateLimited('GET', '/api/livez')).toBe(false);
        expect(isApiReadRateLimited('GET', '/api/readyz')).toBe(false);
        // Defensive: no false-positive on /api/healthcheck (similar prefix).
        // healthcheck doesn't start with /api/t/, so it's already excluded
        // by the primary gate, but if a future PR widens the matcher this
        // assertion catches an accidental over-exclusion of /api/health*.
        expect(isApiReadRateLimited('GET', '/api/healthcheck')).toBe(false);
    });

    it('excludes /api/docs', () => {
        expect(isApiReadRateLimited('GET', '/api/docs')).toBe(false);
        expect(isApiReadRateLimited('GET', '/api/docs/openapi.json')).toBe(false);
    });
});

describe('extractTenantSlug', () => {
    it('returns the slug for tenant-scoped paths', () => {
        expect(extractTenantSlug('/api/t/acme-corp/controls')).toBe('acme-corp');
        expect(extractTenantSlug('/api/t/with-dashes/risks?q=foo')).toBe('with-dashes');
    });

    it('returns null when the path does not match the shape', () => {
        expect(extractTenantSlug('/api/health')).toBe(null);
        expect(extractTenantSlug('/api/admin/tenants')).toBe(null);
        expect(extractTenantSlug('/dashboard')).toBe(null);
    });
});

describe('checkApiReadRateLimit (memory mode)', () => {
    beforeEach(() => {
        _clearApiReadRateLimitMemory();
        // Re-pin the env state — earlier tests may have leaked changes.
        process.env.RATE_LIMIT_MODE = 'memory';
        delete process.env.RATE_LIMIT_ENABLED;
        delete process.env.AUTH_TEST_MODE;
        delete process.env.NEXT_TEST_MODE;
    });

    it('allows requests up to the configured threshold', async () => {
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.1' });
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            const result = await checkApiReadRateLimit(req, 'user-1', 'acme-corp');
            expect(result.ok).toBe(true);
            expect(result.response).toBeUndefined();
        }
    });

    it('returns 429 with Retry-After once the threshold is exceeded', async () => {
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.1' });
        // Burn the budget.
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            await checkApiReadRateLimit(req, 'user-1', 'acme-corp');
        }

        const result = await checkApiReadRateLimit(req, 'user-1', 'acme-corp');

        expect(result.ok).toBe(false);
        expect(result.response).toBeDefined();
        expect(result.response!.status).toBe(429);

        const body = await result.response!.json();
        expect(body.error.code).toBe('RATE_LIMITED');
        expect(body.error.scope).toBe('api-read');
        expect(body.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);

        // RFC-compliant Retry-After + informational X-RateLimit-* headers.
        expect(result.response!.headers.get('Retry-After')).toMatch(/^\d+$/);
        expect(result.response!.headers.get('X-RateLimit-Limit')).toBe(
            String(API_READ_LIMIT.maxAttempts),
        );
        expect(result.response!.headers.get('X-RateLimit-Remaining')).toBe('0');
        expect(result.response!.headers.get('X-RateLimit-Reset')).toMatch(/^\d+$/);

        // Sensitive data MUST NOT appear in the response.
        const bodyStr = JSON.stringify(body);
        expect(bodyStr).not.toContain('203.0.113.1');
        expect(bodyStr).not.toContain('user-1');
    });

    it('isolates buckets per (tenant, user) — one user does not starve another', async () => {
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.1' });
        // Burn user-1's budget.
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            await checkApiReadRateLimit(req, 'user-1', 'acme-corp');
        }

        // user-1 is now blocked.
        const blocked = await checkApiReadRateLimit(req, 'user-1', 'acme-corp');
        expect(blocked.ok).toBe(false);

        // user-2 on the SAME IP and SAME tenant still has full budget.
        const otherUser = await checkApiReadRateLimit(req, 'user-2', 'acme-corp');
        expect(otherUser.ok).toBe(true);
    });

    it('isolates buckets per tenant — same user across tenants is independent', async () => {
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.1' });
        // Burn user-1's budget in tenant A.
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            await checkApiReadRateLimit(req, 'user-1', 'tenant-a');
        }

        const blockedInA = await checkApiReadRateLimit(req, 'user-1', 'tenant-a');
        expect(blockedInA.ok).toBe(false);

        const okInB = await checkApiReadRateLimit(req, 'user-1', 'tenant-b');
        expect(okInB.ok).toBe(true);
    });

    it('falls back to anon bucket when userId is null', async () => {
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.99' });
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            const r = await checkApiReadRateLimit(req, null, 'acme-corp');
            expect(r.ok).toBe(true);
        }
        const blocked = await checkApiReadRateLimit(req, null, 'acme-corp');
        expect(blocked.ok).toBe(false);
    });

    it('respects RATE_LIMIT_ENABLED=0 bypass', async () => {
        process.env.RATE_LIMIT_ENABLED = '0';
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.1' });
        // Pile on far past the threshold — bypass must let everything through.
        for (let i = 0; i < API_READ_LIMIT.maxAttempts * 2; i++) {
            const r = await checkApiReadRateLimit(req, 'user-1', 'acme-corp');
            expect(r.ok).toBe(true);
        }
    });

    it('respects AUTH_TEST_MODE=1 bypass', async () => {
        process.env.AUTH_TEST_MODE = '1';
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.1' });
        for (let i = 0; i < API_READ_LIMIT.maxAttempts * 2; i++) {
            const r = await checkApiReadRateLimit(req, 'user-1', 'acme-corp');
            expect(r.ok).toBe(true);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────
// Branch coverage for the client-IP derivation, the window rollover and
// the third bypass gate (issue #2214 — `./src/lib/` branch floor).
//
// `getClientIp` is not exported, so every assertion below is BEHAVIOURAL:
// two requests that resolve to the SAME bucket IP must share one budget,
// and two that resolve differently must not. Burning one and observing
// the other is the only way to see which header the derivation used.
// ─────────────────────────────────────────────────────────────────────

/** Burn a bucket to exactly its limit; every one of those must be allowed. */
async function burn(req: NextRequest, userId: string | null, slug: string | null): Promise<void> {
    for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
        const r = await checkApiReadRateLimit(req, userId, slug);
        expect(r.ok).toBe(true);
    }
}

describe('checkApiReadRateLimit — client-IP derivation drives the bucket', () => {
    beforeEach(() => {
        _clearApiReadRateLimitMemory();
        process.env.RATE_LIMIT_MODE = 'memory';
        delete process.env.RATE_LIMIT_ENABLED;
        delete process.env.AUTH_TEST_MODE;
        delete process.env.NEXT_TEST_MODE;
    });

    it('uses the FIRST x-forwarded-for entry, trimmed', async () => {
        // Padded, with a downstream proxy hop appended.
        await burn(fakeReq({ 'x-forwarded-for': '  198.51.100.7 , 10.0.0.1' }), 'u', 'acme');

        // Same client, canonical form — must land in the SAME bucket.
        const same = await checkApiReadRateLimit(
            fakeReq({ 'x-forwarded-for': '198.51.100.7' }), 'u', 'acme',
        );
        expect(same.ok).toBe(false);

        // A different client is unaffected — proves we did not collapse
        // every XFF value into one bucket.
        const other = await checkApiReadRateLimit(
            fakeReq({ 'x-forwarded-for': '198.51.100.8' }), 'u', 'acme',
        );
        expect(other.ok).toBe(true);

        // And the SECOND hop is not what we keyed on.
        const hop = await checkApiReadRateLimit(
            fakeReq({ 'x-forwarded-for': '10.0.0.1' }), 'u', 'acme',
        );
        expect(hop.ok).toBe(true);
    });

    it('falls back to x-real-ip when x-forwarded-for is absent', async () => {
        await burn(fakeReq({ 'x-forwarded-for': '198.51.100.7' }), 'u', 'acme');

        const viaRealIp = await checkApiReadRateLimit(
            fakeReq({ 'x-real-ip': '198.51.100.7' }), 'u', 'acme',
        );
        expect(viaRealIp.ok).toBe(false);
    });

    it('falls back to x-real-ip when the first x-forwarded-for entry is EMPTY', async () => {
        // A malformed header (leading comma) must not key the bucket on ''.
        await burn(
            fakeReq({ 'x-forwarded-for': ' , 10.0.0.1', 'x-real-ip': '198.51.100.20' }),
            'u',
            'acme',
        );

        const viaRealIp = await checkApiReadRateLimit(
            fakeReq({ 'x-real-ip': '198.51.100.20' }), 'u', 'acme',
        );
        expect(viaRealIp.ok).toBe(false);

        // The 10.0.0.1 hop in the malformed header was NOT used.
        const hop = await checkApiReadRateLimit(
            fakeReq({ 'x-forwarded-for': '10.0.0.1' }), 'u', 'acme',
        );
        expect(hop.ok).toBe(true);
    });

    it('defaults to 127.0.0.1 when neither forwarding header is present', async () => {
        await burn(fakeReq(), 'u', 'acme');

        const loopback = await checkApiReadRateLimit(
            fakeReq({ 'x-forwarded-for': '127.0.0.1' }), 'u', 'acme',
        );
        expect(loopback.ok).toBe(false);
    });

    it('treats a whitespace-only x-real-ip as absent', async () => {
        await burn(fakeReq({ 'x-real-ip': '   ' }), 'u', 'acme');

        // Both resolved to the 127.0.0.1 default, so they share a budget.
        const noHeaders = await checkApiReadRateLimit(fakeReq(), 'u', 'acme');
        expect(noHeaders.ok).toBe(false);
    });

    it('gives a null tenantSlug its own bucket, independent of named tenants', async () => {
        const req = fakeReq({ 'x-forwarded-for': '198.51.100.30' });
        await burn(req, 'u', null);

        expect((await checkApiReadRateLimit(req, 'u', null)).ok).toBe(false);
        expect((await checkApiReadRateLimit(req, 'u', 'acme')).ok).toBe(true);
    });
});

describe('checkApiReadRateLimit — window rollover (mocked clock)', () => {
    // The clock is driven from a fixed BASE and only ever advanced by
    // deltas relative to it. Nothing here reads or asserts wall-clock
    // time, so the suite cannot rot overnight.
    const BASE = 1_700_000_000_000;
    let now = BASE;

    beforeEach(() => {
        _clearApiReadRateLimitMemory();
        process.env.RATE_LIMIT_MODE = 'memory';
        delete process.env.RATE_LIMIT_ENABLED;
        delete process.env.AUTH_TEST_MODE;
        delete process.env.NEXT_TEST_MODE;
        now = BASE;
        jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('reports a deterministic Retry-After and Reset derived from the frozen clock', async () => {
        const req = fakeReq({ 'x-forwarded-for': '198.51.100.40' });
        await burn(req, 'u', 'acme');

        const blocked = await checkApiReadRateLimit(req, 'u', 'acme');
        expect(blocked.ok).toBe(false);

        const res = blocked.response!;
        const windowSeconds = API_READ_LIMIT.windowMs / 1000;
        expect(res.headers.get('Retry-After')).toBe(String(windowSeconds));
        expect(res.headers.get('X-RateLimit-Reset')).toBe(String(BASE + API_READ_LIMIT.windowMs));
        expect(res.headers.get('X-RateLimit-Limit')).toBe(String(API_READ_LIMIT.maxAttempts));
        expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');

        const body = await res.json();
        expect(body.error.retryAfterSeconds).toBe(windowSeconds);
        expect(body.error.message).toBe(
            `Too many read requests. Retry after ${windowSeconds} seconds.`,
        );
    });

    it('is STILL blocked at exactly resetAt — expiry is strictly greater-than', async () => {
        const req = fakeReq({ 'x-forwarded-for': '198.51.100.41' });
        await burn(req, 'u', 'acme');

        // now === resetAt: `now > record.resetAt` is false, so the same
        // window is still in force. A `>=` here would leak a free request.
        now = BASE + API_READ_LIMIT.windowMs;
        expect((await checkApiReadRateLimit(req, 'u', 'acme')).ok).toBe(false);
    });

    it('resets the COUNTER (not just the timestamp) once the window elapses', async () => {
        const req = fakeReq({ 'x-forwarded-for': '198.51.100.42' });
        await burn(req, 'u', 'acme');
        expect((await checkApiReadRateLimit(req, 'u', 'acme')).ok).toBe(false);

        now = BASE + API_READ_LIMIT.windowMs + 1;

        // A full fresh budget must be available — bumping only `resetAt`
        // while leaving `count` at the cap would allow exactly one.
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            expect((await checkApiReadRateLimit(req, 'u', 'acme')).ok).toBe(true);
        }
        const overAgain = await checkApiReadRateLimit(req, 'u', 'acme');
        expect(overAgain.ok).toBe(false);
        // The new window is anchored on the FIRST request of that window.
        expect(overAgain.response!.headers.get('X-RateLimit-Reset')).toBe(
            String(now + API_READ_LIMIT.windowMs),
        );
    });
});

describe('checkApiReadRateLimit — NEXT_TEST_MODE bypass', () => {
    beforeEach(() => {
        _clearApiReadRateLimitMemory();
        process.env.RATE_LIMIT_MODE = 'memory';
        delete process.env.RATE_LIMIT_ENABLED;
        delete process.env.AUTH_TEST_MODE;
        delete process.env.NEXT_TEST_MODE;
    });

    afterEach(() => {
        delete process.env.NEXT_TEST_MODE;
    });

    it('NEXT_TEST_MODE=1 returns before any counting happens', async () => {
        process.env.NEXT_TEST_MODE = '1';
        const req = fakeReq({ 'x-forwarded-for': '198.51.100.50' });
        for (let i = 0; i < API_READ_LIMIT.maxAttempts * 2; i++) {
            expect((await checkApiReadRateLimit(req, 'u', 'acme')).ok).toBe(true);
        }

        // Turning the bypass off must reveal an UNTOUCHED budget — proving
        // the gate returned before `checkMemory` incremented anything,
        // rather than merely discarding the verdict.
        delete process.env.NEXT_TEST_MODE;
        await burn(req, 'u', 'acme');
        expect((await checkApiReadRateLimit(req, 'u', 'acme')).ok).toBe(false);
    });

    it('a NEXT_TEST_MODE value other than "1" does NOT bypass', async () => {
        process.env.NEXT_TEST_MODE = 'true';
        const req = fakeReq({ 'x-forwarded-for': '198.51.100.51' });
        await burn(req, 'u', 'acme');
        expect((await checkApiReadRateLimit(req, 'u', 'acme')).ok).toBe(false);
    });
});
