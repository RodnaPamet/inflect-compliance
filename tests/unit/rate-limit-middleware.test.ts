/**
 * Unit Test: Epic A.2 rate-limit middleware.
 *
 * Pins the middleware's contract surface:
 *   - IP extraction fallback chain
 *   - keying (auth vs anon; separate budgets per (IP, userId))
 *   - 429 response shape: status, Retry-After header, safe JSON body
 *   - X-RateLimit-* informational headers
 *   - withRateLimit wrapper short-circuits blocked requests before
 *     the handler runs; passes through successful ones
 *   - preset sanity: each preset is a realistic policy, not a typo
 */

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
    },
}));

import {
    getClientIp,
    buildRateLimitKey,
    enforceRateLimit,
    withRateLimit,
    LOGIN_LIMIT,
    API_MUTATION_LIMIT,
    API_KEY_CREATE_LIMIT,
    EMAIL_DISPATCH_LIMIT,
    API_READ_LIMIT,
    INVITE_REDEEM_LIMIT,
    MFA_VERIFY_LIMIT,
    MFA_ENROLL_VERIFY_LIMIT,
    TENANT_INVITE_CREATE_LIMIT,
    clearAllRateLimits,
} from '@/lib/security/rate-limit-middleware';
// NOT from the barrel, because the barrel does not re-export it — the only
// one of the ten it omits. The barrel's own guardrail argues a contributor
// "must find API_READ_LIMIT there"; the same argument applies here and the
// gap is noted rather than papered over by importing it from the barrel it
// is absent from.
import { TENANT_CREATE_LIMIT } from '@/lib/security/rate-limit';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Build a minimal NextRequest-compatible object for tests. We use a
 * real URL + Headers so the middleware's type checks hold without
 * a running Next server.
 */
function fakeReq(options: {
    url?: string;
    forwardedFor?: string;
    realIp?: string;
    ip?: string;
} = {}): NextRequest {
    const headers = new Headers();
    if (options.forwardedFor) headers.set('x-forwarded-for', options.forwardedFor);
    if (options.realIp) headers.set('x-real-ip', options.realIp);
    const req = new NextRequest(options.url ?? 'http://localhost/api/x', {
        method: 'POST',
        headers,
    });
    if (options.ip) {
        // NextRequest.ip is readonly; test-only override.
        Object.defineProperty(req, 'ip', { value: options.ip, configurable: true });
    }
    return req;
}

describe('getClientIp', () => {
    it('prefers x-forwarded-for first value', () => {
        const req = fakeReq({ forwardedFor: '1.2.3.4, 5.6.7.8' });
        expect(getClientIp(req)).toBe('1.2.3.4');
    });

    it('falls through to x-real-ip when x-forwarded-for is absent', () => {
        const req = fakeReq({ realIp: '9.9.9.9' });
        expect(getClientIp(req)).toBe('9.9.9.9');
    });

    it('falls through to req.ip when headers are absent', () => {
        const req = fakeReq({ ip: '10.0.0.1' });
        expect(getClientIp(req)).toBe('10.0.0.1');
    });

    it("returns 'unknown' when every source is missing", () => {
        const req = fakeReq();
        expect(getClientIp(req)).toBe('unknown');
    });

    it('trims whitespace around forwarded values', () => {
        const req = fakeReq({ forwardedFor: '   1.2.3.4   ,5.6.7.8' });
        expect(getClientIp(req)).toBe('1.2.3.4');
    });
});

describe('buildRateLimitKey', () => {
    it('includes scope, ip, and userId for authenticated callers', () => {
        expect(buildRateLimitKey('login', '1.2.3.4', 'user-1')).toBe(
            'login:ip:1.2.3.4:u:user-1'
        );
    });

    it('uses anon bucket when userId is null or undefined', () => {
        expect(buildRateLimitKey('login', '1.2.3.4', null)).toBe(
            'login:ip:1.2.3.4:anon'
        );
        expect(buildRateLimitKey('login', '1.2.3.4')).toBe(
            'login:ip:1.2.3.4:anon'
        );
    });

    it('keeps scopes isolated from each other', () => {
        const a = buildRateLimitKey('login', '1.2.3.4', 'user-1');
        const b = buildRateLimitKey('api-mutation', '1.2.3.4', 'user-1');
        expect(a).not.toBe(b);
    });
});

describe('enforceRateLimit', () => {
    beforeEach(() => {
        clearAllRateLimits();
        jest.clearAllMocks();
    });

    it('allows requests under the budget and reports remaining', () => {
        const req = fakeReq({ forwardedFor: '1.1.1.1' });
        const first = enforceRateLimit(req, {
            scope: 'test-scope',
            config: { maxAttempts: 3, windowMs: 60_000 },
            userId: 'u1',
        });
        expect(first.response).toBeUndefined();
        expect(first.result.allowed).toBe(true);
        expect(first.result.remaining).toBe(2);

        const second = enforceRateLimit(req, {
            scope: 'test-scope',
            config: { maxAttempts: 3, windowMs: 60_000 },
            userId: 'u1',
        });
        expect(second.result.remaining).toBe(1);
    });

    it('returns a 429 response once the budget is exhausted', async () => {
        const req = fakeReq({ forwardedFor: '2.2.2.2' });
        const config = { maxAttempts: 2, windowMs: 60_000 };
        enforceRateLimit(req, { scope: 'burst', config, userId: 'u2' });
        enforceRateLimit(req, { scope: 'burst', config, userId: 'u2' });
        const blocked = enforceRateLimit(req, {
            scope: 'burst',
            config,
            userId: 'u2',
        });

        expect(blocked.response).toBeDefined();
        expect(blocked.response?.status).toBe(429);
        expect(blocked.result.allowed).toBe(false);

        const body = await blocked.response!.json();
        expect(body.error.code).toBe('RATE_LIMITED');
        expect(body.error.scope).toBe('burst');
        expect(typeof body.error.retryAfterSeconds).toBe('number');
        expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('sets Retry-After and X-RateLimit-* headers on 429', async () => {
        const req = fakeReq({ forwardedFor: '3.3.3.3' });
        const config = { maxAttempts: 1, windowMs: 60_000 };
        enforceRateLimit(req, { scope: 'hdr', config });
        const blocked = enforceRateLimit(req, { scope: 'hdr', config });

        expect(blocked.response).toBeDefined();
        const h = blocked.response!.headers;
        expect(h.get('Retry-After')).toMatch(/^\d+$/);
        expect(Number(h.get('Retry-After'))).toBeGreaterThan(0);
        expect(h.get('X-RateLimit-Limit')).toBe('1');
        expect(h.get('X-RateLimit-Remaining')).toBe('0');
        expect(h.get('X-RateLimit-Reset')).toMatch(/^\d+$/);
    });

    it('429 body never leaks the key, IP, or userId', async () => {
        const req = fakeReq({ forwardedFor: '4.4.4.4' });
        const config = { maxAttempts: 1, windowMs: 60_000 };
        enforceRateLimit(req, { scope: 's', config, userId: 'user-secret' });
        const blocked = enforceRateLimit(req, {
            scope: 's',
            config,
            userId: 'user-secret',
        });
        const body = JSON.stringify(await blocked.response!.json());
        expect(body).not.toContain('user-secret');
        expect(body).not.toContain('4.4.4.4');
        expect(body).not.toContain('ip:');
    });

    it('retryAfterSeconds is never less than 1 (never silently 0)', async () => {
        const req = fakeReq({ forwardedFor: '5.5.5.5' });
        const config = { maxAttempts: 1, windowMs: 10 }; // sub-second
        enforceRateLimit(req, { scope: 's', config });
        const blocked = enforceRateLimit(req, { scope: 's', config });
        const body = await blocked.response!.json();
        expect(body.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });
});

describe('keying isolation', () => {
    beforeEach(() => {
        clearAllRateLimits();
    });

    it('different users on same IP have independent budgets', () => {
        const req = fakeReq({ forwardedFor: '10.0.0.1' });
        const config = { maxAttempts: 1, windowMs: 60_000 };

        const a = enforceRateLimit(req, {
            scope: 'iso',
            config,
            userId: 'alice',
        });
        const b = enforceRateLimit(req, {
            scope: 'iso',
            config,
            userId: 'bob',
        });

        expect(a.response).toBeUndefined();
        expect(b.response).toBeUndefined();
    });

    it('same user on different IPs have independent budgets', () => {
        const config = { maxAttempts: 1, windowMs: 60_000 };

        const fromOffice = enforceRateLimit(
            fakeReq({ forwardedFor: '10.0.0.1' }),
            { scope: 'iso2', config, userId: 'alice' }
        );
        const fromHome = enforceRateLimit(
            fakeReq({ forwardedFor: '192.168.1.1' }),
            { scope: 'iso2', config, userId: 'alice' }
        );

        expect(fromOffice.response).toBeUndefined();
        expect(fromHome.response).toBeUndefined();
    });

    it('unauthenticated traffic from same IP shares a bucket', () => {
        const config = { maxAttempts: 1, windowMs: 60_000 };

        const first = enforceRateLimit(
            fakeReq({ forwardedFor: '10.10.10.10' }),
            { scope: 'anon-scope', config }
        );
        const second = enforceRateLimit(
            fakeReq({ forwardedFor: '10.10.10.10' }),
            { scope: 'anon-scope', config }
        );

        expect(first.response).toBeUndefined();
        expect(second.response).toBeDefined();
        expect(second.response?.status).toBe(429);
    });

    it('unauthenticated and authenticated from same IP have separate budgets', () => {
        const config = { maxAttempts: 1, windowMs: 60_000 };
        const req = fakeReq({ forwardedFor: '20.20.20.20' });

        const anon = enforceRateLimit(req, {
            scope: 'mixed',
            config,
        });
        const auth = enforceRateLimit(req, {
            scope: 'mixed',
            config,
            userId: 'signed-in',
        });

        expect(anon.response).toBeUndefined();
        expect(auth.response).toBeUndefined();
    });
});

describe('withRateLimit wrapper', () => {
    beforeEach(() => {
        clearAllRateLimits();
    });

    it('invokes the handler when under the budget', async () => {
        const handler = jest.fn(async () =>
            NextResponse.json({ ok: true })
        );
        const wrapped = withRateLimit(handler, {
            scope: 'w1',
            config: { maxAttempts: 3, windowMs: 60_000 },
        });

        const res = await wrapped(fakeReq({ forwardedFor: '1.1.1.1' }));
        expect(handler).toHaveBeenCalledTimes(1);
        expect(res.status).toBe(200);
    });

    it('short-circuits to 429 without calling the handler when blocked', async () => {
        const handler = jest.fn(async () =>
            NextResponse.json({ ok: true })
        );
        const wrapped = withRateLimit(handler, {
            scope: 'w2',
            config: { maxAttempts: 1, windowMs: 60_000 },
        });

        const req = fakeReq({ forwardedFor: '1.2.3.4' });
        await wrapped(req);
        const blocked = await wrapped(req);

        expect(handler).toHaveBeenCalledTimes(1); // second call blocked
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('Retry-After')).toMatch(/^\d+$/);
    });

    it('resolves userId via getUserId for keying', async () => {
        const handler = jest.fn(async () =>
            NextResponse.json({ ok: true })
        );
        const getUserId = jest.fn(async () => 'resolved-user');
        const wrapped = withRateLimit(handler, {
            scope: 'w3',
            config: { maxAttempts: 100, windowMs: 60_000 },
            getUserId,
        });

        await wrapped(fakeReq({ forwardedFor: '1.1.1.1' }));
        expect(getUserId).toHaveBeenCalled();
        expect(handler).toHaveBeenCalled();
    });

    it('treats a getUserId throw as anonymous (falls back cleanly)', async () => {
        const handler = jest.fn(async () =>
            NextResponse.json({ ok: true })
        );
        const wrapped = withRateLimit(handler, {
            scope: 'w4',
            config: { maxAttempts: 1, windowMs: 60_000 },
            getUserId: async () => {
                throw new Error('no session yet');
            },
        });

        const res = await wrapped(fakeReq({ forwardedFor: '1.1.1.1' }));
        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalled();
    });

    it('forwards additional route params to the handler', async () => {
        const handler = jest.fn(async (_req, params) =>
            NextResponse.json({ params })
        );
        const wrapped = withRateLimit(handler, {
            scope: 'w5',
            config: { maxAttempts: 3, windowMs: 60_000 },
        });

        await wrapped(fakeReq({ forwardedFor: '1.1.1.1' }), { tenantSlug: 'acme' });
        expect(handler.mock.calls[0][1]).toEqual({ tenantSlug: 'acme' });
    });
});

describe('Preset policy sanity', () => {
    // Guardrails on the presets themselves — catches a typo that
    // accidentally makes a preset too permissive or disables a lockout.
    const CASES: Array<[string, typeof LOGIN_LIMIT]> = [
        ['LOGIN_LIMIT', LOGIN_LIMIT],
        ['API_MUTATION_LIMIT', API_MUTATION_LIMIT],
        ['API_KEY_CREATE_LIMIT', API_KEY_CREATE_LIMIT],
        ['EMAIL_DISPATCH_LIMIT', EMAIL_DISPATCH_LIMIT],
    ];

    it.each(CASES)('%s has a positive maxAttempts', (_, preset) => {
        expect(preset.maxAttempts).toBeGreaterThan(0);
    });

    it.each(CASES)('%s has a positive windowMs', (_, preset) => {
        expect(preset.windowMs).toBeGreaterThan(0);
    });

    /**
     * EVERY preset's MAGNITUDE, pinned (#3312).
     *
     * The assertions around this one are all relational or positivity —
     * `maxAttempts > 0`, `windowMs > 0`, `lockoutMs > 0`, mutation ≥ login,
     * key-create ≤ both. Each is true and none of them bounds a number. So
     * the whole family survives a uniform weakening: MEASURED by multiplying
     * every `maxAttempts` by 1000 and setting every `lockoutMs` to 1ms, then
     * running the three suites that cover these presets — **51 tests, all
     * green**. A rate limit of 120000 per minute is not a rate limit, and a
     * 1ms lockout does not lock anybody out.
     *
     * Three of these are PUBLISHED to customers — `docs/rate-limiting.md`,
     * `docs/api-consumer-guide.md` and `docs/security-hardening.md` state the
     * read (120/min), mutation (60/min) and auth (10/min) budgets — so for
     * those a change has documents to move with it. The other seven have no
     * external anchor, and rather than invent an upper bound for each (a
     * guessed constant is the thing this repo's notes warn about), they are
     * pinned to what they are. The point is not to prevent tuning: it is that
     * tuning a security budget should be a deliberate edit with a reviewer,
     * not a number that can drift by a factor of a thousand in silence.
     */
    const MAGNITUDES: Array<[string, typeof LOGIN_LIMIT, number, number, number | undefined]> = [
        ['LOGIN_LIMIT', LOGIN_LIMIT, 10, 15 * 60 * 1000, 15 * 60 * 1000],
        ['API_MUTATION_LIMIT', API_MUTATION_LIMIT, 60, 60 * 1000, undefined],
        ['API_READ_LIMIT', API_READ_LIMIT, 120, 60 * 1000, undefined],
        ['API_KEY_CREATE_LIMIT', API_KEY_CREATE_LIMIT, 5, 60 * 60 * 1000, 60 * 60 * 1000],
        ['EMAIL_DISPATCH_LIMIT', EMAIL_DISPATCH_LIMIT, 5, 60 * 60 * 1000, undefined],
        ['TENANT_CREATE_LIMIT', TENANT_CREATE_LIMIT, 5, 60 * 60 * 1000, 60 * 60 * 1000],
        [
            'TENANT_INVITE_CREATE_LIMIT',
            TENANT_INVITE_CREATE_LIMIT,
            20,
            60 * 60 * 1000,
            undefined,
        ],
        ['INVITE_REDEEM_LIMIT', INVITE_REDEEM_LIMIT, 10, 60 * 1000, undefined],
        ['MFA_VERIFY_LIMIT', MFA_VERIFY_LIMIT, 5, 15 * 60 * 1000, 5 * 60 * 1000],
        ['MFA_ENROLL_VERIFY_LIMIT', MFA_ENROLL_VERIFY_LIMIT, 10, 15 * 60 * 1000, undefined],
    ];

    it('the pinned table covers every preset the module exports', () => {
        // The denominator, asserted. A table that silently stops covering a
        // preset would leave that one free to drift while reading as though
        // every preset were pinned — and a new preset added without a row
        // here is exactly how that happens.
        const exported = Object.entries(
            require('@/lib/security/rate-limit') as Record<string, unknown>,
        )
            .filter(
                ([k, v]) =>
                    /_LIMIT$/.test(k)
                    && typeof v === 'object'
                    && v !== null
                    && 'maxAttempts' in (v as object),
            )
            .map(([k]) => k)
            .sort();
        expect(MAGNITUDES.map(([n]) => n).sort()).toEqual(exported);
    });

    it.each(MAGNITUDES)(
        '%s is exactly its stated budget',
        (_name, preset, maxAttempts, windowMs, lockoutMs) => {
            expect(preset.maxAttempts).toBe(maxAttempts);
            expect(preset.windowMs).toBe(windowMs);
            expect(preset.lockoutMs).toBe(lockoutMs);
        },
    );

    it('LOGIN_LIMIT + API_KEY_CREATE_LIMIT have a lockout', () => {
        expect(LOGIN_LIMIT.lockoutMs).toBeGreaterThan(0);
        expect(API_KEY_CREATE_LIMIT.lockoutMs).toBeGreaterThan(0);
    });

    it('API_MUTATION_LIMIT budget ≥ LOGIN_LIMIT budget (mutation is a high-traffic surface)', () => {
        expect(API_MUTATION_LIMIT.maxAttempts).toBeGreaterThanOrEqual(
            LOGIN_LIMIT.maxAttempts
        );
    });

    it('API_KEY_CREATE_LIMIT is the tightest preset (most sensitive)', () => {
        expect(API_KEY_CREATE_LIMIT.maxAttempts).toBeLessThanOrEqual(
            LOGIN_LIMIT.maxAttempts
        );
        expect(API_KEY_CREATE_LIMIT.maxAttempts).toBeLessThanOrEqual(
            API_MUTATION_LIMIT.maxAttempts
        );
    });
});
