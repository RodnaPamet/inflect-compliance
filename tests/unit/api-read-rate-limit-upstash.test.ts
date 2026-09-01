/**
 * GAP-17 read-tier rate limit — the UPSTASH arm.
 *
 * `tests/unit/api-read-rate-limit.test.ts` pins the memory fallback and
 * the match/exclusion predicates. It pins the env to `memory` at module
 * load, so the Upstash construction path, the Upstash verdict mapping and
 * the two fail-open branches were never executed by anything.
 *
 * Those branches are the ones that matter operationally: a Redis outage
 * MUST let reads through (fail-open, same posture as authRateLimit), and a
 * blocked verdict must carry Upstash's own limit/reset values rather than
 * the local preset. Both are silent-failure classes — a regression here
 * either browns out the API during a Redis blip or reports headers that
 * lie to the client.
 *
 * Style follows `tests/unit/credential-rate-limit.test.ts`: `jest.doMock`
 * plus `jest.resetModules()` and a dynamic import, so the mocked
 * `@upstash/*` modules are in place before the module under test captures
 * them, with no hoisting/TDZ games.
 */
import type { NextRequest } from 'next/server';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';

// The bypass gates are read on every call — keep all three off so the
// limiter actually runs. Set explicitly rather than relying on a default
// from `tests/mocks/env.ts` (that mock reads process.env first, so an
// assertion against its fallback silently depends on the var being unset).
process.env.RATE_LIMIT_MODE = 'upstash';
delete process.env.RATE_LIMIT_ENABLED;
delete process.env.AUTH_TEST_MODE;
delete process.env.NEXT_TEST_MODE;

/** The subset of `@upstash/ratelimit`'s verdict this module consumes. */
interface UpstashVerdict {
    success: boolean;
    limit: number;
    remaining: number;
    reset: number;
}

type ApiReadModule = typeof import('@/lib/rate-limit/apiReadRateLimit');
type EdgeLoggerModule = typeof import('@/lib/observability/edge-logger');

// Declared with `mock`-prefixed names and only ever referenced from
// `jest.doMock` factories that run at dynamic-import time.
const mockLimit = jest.fn<Promise<UpstashVerdict>, [string]>();
const mockFromEnv = jest.fn<{ marker: string }, []>(() => ({ marker: 'redis' }));
const mockRatelimitCtor = jest.fn<void, [Record<string, unknown>]>();
const mockSlidingWindow = jest.fn<{ n: number; w: string }, [number, string]>(
    (n: number, w: string) => ({ n, w }),
);
const mockLogError = jest.fn<void, [string, Record<string, unknown>?]>();
const mockLogWarn = jest.fn<void, [string, Record<string, unknown>?]>();

function fakeReq(headers: Record<string, string> = {}): NextRequest {
    // Only `.headers.get()` is touched by the module under test.
    return {
        headers: {
            get: (name: string): string | null => headers[name.toLowerCase()] ?? null,
        },
    } as unknown as NextRequest;
}

/**
 * Install the `@upstash/*` + edge-logger doubles and load a FRESH copy of
 * the module under test, so its `_initialized` / `_limiter` module state
 * starts clean for every case.
 *
 * @param fromEnvThrows - make `Redis.fromEnv()` throw, exercising the
 *   construction-failure branch of `init()`.
 */
async function loadModule(fromEnvThrows = false): Promise<ApiReadModule> {
    jest.resetModules();

    jest.doMock('@upstash/redis', () => ({
        Redis: {
            fromEnv: (): { marker: string } => {
                if (fromEnvThrows) throw new Error('no upstash credentials');
                return mockFromEnv();
            },
        },
    }));

    jest.doMock('@upstash/ratelimit', () => ({
        Ratelimit: Object.assign(
            function Ratelimit(this: unknown, opts: Record<string, unknown>) {
                mockRatelimitCtor(opts);
                return { limit: mockLimit };
            },
            { slidingWindow: mockSlidingWindow },
        ),
    }));

    jest.doMock('@/lib/observability/edge-logger', () => ({
        edgeLogger: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: mockLogWarn,
            error: mockLogError,
        },
    }));

    const mod = await import('@/lib/rate-limit/apiReadRateLimit');
    mod._clearApiReadRateLimitMemory();
    return mod;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockSlidingWindow.mockImplementation((n: number, w: string) => ({ n, w }));
    mockFromEnv.mockImplementation(() => ({ marker: 'redis' }));
    process.env.RATE_LIMIT_MODE = 'upstash';
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.AUTH_TEST_MODE;
    delete process.env.NEXT_TEST_MODE;
});

afterEach(() => {
    jest.dontMock('@upstash/redis');
    jest.dontMock('@upstash/ratelimit');
    jest.dontMock('@/lib/observability/edge-logger');
    jest.restoreAllMocks();
});

describe('init() — Upstash limiter construction', () => {
    it('builds the limiter from the shared preset under the rl:api-read prefix', async () => {
        const mod = await loadModule();
        mockLimit.mockResolvedValue({
            success: true,
            limit: API_READ_LIMIT.maxAttempts,
            remaining: 119,
            reset: Date.now() + 60_000,
        });

        await mod.checkApiReadRateLimit(fakeReq(), 'u', 'acme');

        // The numbers come from `@/lib/security/rate-limit`, not a local
        // copy — that single-source-of-truth is the module's stated design.
        expect(mockSlidingWindow).toHaveBeenCalledWith(
            API_READ_LIMIT.maxAttempts,
            `${API_READ_LIMIT.windowMs} ms`,
        );
        expect(mockRatelimitCtor).toHaveBeenCalledTimes(1);
        const opts = mockRatelimitCtor.mock.calls[0][0];
        expect(opts.prefix).toBe('rl:api-read');
        expect(opts.redis).toStrictEqual({ marker: 'redis' });
        expect(opts.limiter).toStrictEqual({
            n: API_READ_LIMIT.maxAttempts,
            w: `${API_READ_LIMIT.windowMs} ms`,
        });
    });

    it('initialises ONCE across many requests', async () => {
        const mod = await loadModule();
        mockLimit.mockResolvedValue({
            success: true,
            limit: 120,
            remaining: 5,
            reset: Date.now() + 60_000,
        });

        for (let i = 0; i < 4; i++) {
            await mod.checkApiReadRateLimit(fakeReq(), 'u', 'acme');
        }
        expect(mockRatelimitCtor).toHaveBeenCalledTimes(1);
        expect(mockLimit).toHaveBeenCalledTimes(4);
    });

    it('LOGS and degrades to the memory bucket when Redis.fromEnv() throws', async () => {
        const mod = await loadModule(true);

        // Construction failed, so `_limiter` is null and the memory branch
        // must take over — the request is still evaluated, not skipped.
        const req = fakeReq({ 'x-forwarded-for': '198.51.100.60' });
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            expect((await mod.checkApiReadRateLimit(req, 'u', 'acme')).ok).toBe(true);
        }
        const blocked = await mod.checkApiReadRateLimit(req, 'u', 'acme');
        expect(blocked.ok).toBe(false);
        expect(blocked.response!.status).toBe(429);

        // Upstash was never reached.
        expect(mockLimit).not.toHaveBeenCalled();
        expect(mockLogError).toHaveBeenCalledWith(
            'Failed to initialize Upstash for API read rate limit',
            expect.objectContaining({
                component: 'rate-limit',
                err: 'Error: no upstash credentials',
            }),
        );
    });
});

describe('checkApiReadRateLimit — Upstash verdict mapping', () => {
    it('keys the bucket on (tenantSlug, ip, userId) in the documented shape', async () => {
        const mod = await loadModule();
        mockLimit.mockResolvedValue({
            success: true,
            limit: 120,
            remaining: 119,
            reset: Date.now() + 60_000,
        });

        await mod.checkApiReadRateLimit(
            fakeReq({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }),
            'user-1',
            'acme-corp',
        );

        expect(mockLimit).toHaveBeenCalledWith(
            'rl:api-read:t:acme-corp:ip:198.51.100.7:u:user-1',
        );
    });

    it('uses the `unknown` / `anon` placeholders for a null slug and null user', async () => {
        const mod = await loadModule();
        mockLimit.mockResolvedValue({
            success: true,
            limit: 120,
            remaining: 119,
            reset: Date.now() + 60_000,
        });

        await mod.checkApiReadRateLimit(fakeReq({ 'x-real-ip': '203.0.113.9' }), null, null);

        expect(mockLimit).toHaveBeenCalledWith(
            'rl:api-read:t:unknown:ip:203.0.113.9:u:anon',
        );
    });

    it('allows the request and emits no 429 when Upstash says success', async () => {
        const mod = await loadModule();
        mockLimit.mockResolvedValue({
            success: true,
            limit: 120,
            remaining: 42,
            reset: Date.now() + 30_000,
        });

        const result = await mod.checkApiReadRateLimit(fakeReq(), 'u', 'acme');
        expect(result.ok).toBe(true);
        expect(result.response).toBeUndefined();
        expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it("reports UPSTASH's limit/reset on a block, not the local preset", async () => {
        const mod = await loadModule();
        // Deliberately different from API_READ_LIMIT so a regression that
        // re-derives the headers locally is visible.
        const now = 1_700_000_000_000;
        jest.spyOn(Date, 'now').mockReturnValue(now);
        mockLimit.mockResolvedValue({
            success: false,
            limit: 999,
            remaining: 0,
            reset: now + 7_000,
        });

        const result = await mod.checkApiReadRateLimit(
            fakeReq({ 'x-forwarded-for': '198.51.100.7' }),
            'user-1',
            'acme-corp',
        );

        expect(result.ok).toBe(false);
        const res = result.response!;
        expect(res.status).toBe(429);
        expect(res.headers.get('X-RateLimit-Limit')).toBe('999');
        expect(res.headers.get('X-RateLimit-Reset')).toBe(String(now + 7_000));
        expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
        expect(res.headers.get('Retry-After')).toBe('7');

        const body = await res.json();
        expect(body.error.code).toBe('RATE_LIMITED');
        expect(body.error.scope).toBe('api-read');
        expect(body.error.retryAfterSeconds).toBe(7);
        // Neither the IP nor the user id may reach the client body.
        const asText = JSON.stringify(body);
        expect(asText).not.toContain('198.51.100.7');
        expect(asText).not.toContain('user-1');
    });

    it('rounds a sub-second remainder UP rather than to zero', async () => {
        const mod = await loadModule();
        const now = 1_700_000_000_000;
        jest.spyOn(Date, 'now').mockReturnValue(now);
        mockLimit.mockResolvedValue({
            success: false,
            limit: 120,
            remaining: 0,
            reset: now + 1_200,
        });

        const result = await mod.checkApiReadRateLimit(fakeReq(), 'u', 'acme');
        // ceil(1.2) — a floor would tell the client to retry in 1s when the
        // window has 1.2s left, producing an immediate second 429.
        expect(result.response!.headers.get('Retry-After')).toBe('2');
    });

    it('clamps Retry-After to a minimum of 1 when the reset is already in the past', async () => {
        const mod = await loadModule();
        const now = 1_700_000_000_000;
        jest.spyOn(Date, 'now').mockReturnValue(now);
        mockLimit.mockResolvedValue({
            success: false,
            limit: 120,
            remaining: 0,
            reset: now - 5_000,
        });

        const result = await mod.checkApiReadRateLimit(fakeReq(), 'u', 'acme');
        expect(result.ok).toBe(false);
        // Without the Math.max this is -5, and `Retry-After: -5` is an
        // invalid header that clients treat as "retry immediately".
        expect(result.response!.headers.get('Retry-After')).toBe('1');
        const body = await result.response!.json();
        expect(body.error.retryAfterSeconds).toBe(1);
    });

    it('logs the block at warn level WITHOUT the client IP', async () => {
        const mod = await loadModule();
        mockLimit.mockResolvedValue({
            success: false,
            limit: 120,
            remaining: 0,
            reset: Date.now() + 5_000,
        });

        await mod.checkApiReadRateLimit(
            fakeReq({ 'x-forwarded-for': '198.51.100.77' }),
            'user-9',
            'acme-corp',
        );

        expect(mockLogWarn).toHaveBeenCalledTimes(1);
        const [msg, fields] = mockLogWarn.mock.calls[0] as [string, Record<string, unknown>];
        expect(msg).toBe('API read rate limit exceeded');
        expect(fields).toStrictEqual({
            component: 'rate-limit',
            scope: 'api-read',
            tenantSlug: 'acme-corp',
        });
        // The IP is PII and is deliberately absent at warn level.
        expect(JSON.stringify(fields)).not.toContain('198.51.100.77');
    });

    it('substitutes "(unknown)" for a null slug in the warn log', async () => {
        const mod = await loadModule();
        mockLimit.mockResolvedValue({
            success: false,
            limit: 120,
            remaining: 0,
            reset: Date.now() + 5_000,
        });

        await mod.checkApiReadRateLimit(fakeReq(), null, null);

        const [, fields] = mockLogWarn.mock.calls[0] as [string, Record<string, unknown>];
        expect(fields.tenantSlug).toBe('(unknown)');
    });
});

describe('checkApiReadRateLimit — fail-open on an Upstash outage', () => {
    it('ALLOWS the request and logs when limit() rejects', async () => {
        const mod = await loadModule();
        mockLimit.mockRejectedValue(new Error('ECONNRESET'));

        const result = await mod.checkApiReadRateLimit(
            fakeReq({ 'x-forwarded-for': '198.51.100.7' }),
            'u',
            'acme',
        );

        // A Redis blip must never brown out the read API.
        expect(result.ok).toBe(true);
        expect(result.response).toBeUndefined();
        expect(mockLogError).toHaveBeenCalledWith(
            'API read rate limit exception, failing open',
            expect.objectContaining({ component: 'rate-limit', err: 'Error: ECONNRESET' }),
        );
        // Failing open is not the same as blocking silently — no warn.
        expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it('keeps failing open for every subsequent request during the outage', async () => {
        const mod = await loadModule();
        mockLimit.mockRejectedValue(new Error('ECONNRESET'));

        for (let i = 0; i < 5; i++) {
            expect((await mod.checkApiReadRateLimit(fakeReq(), 'u', 'acme')).ok).toBe(true);
        }
        expect(mockLogError).toHaveBeenCalledTimes(5);
    });

    it('bypass gates short-circuit BEFORE Upstash is touched', async () => {
        const mod = await loadModule();
        process.env.RATE_LIMIT_ENABLED = '0';

        const result = await mod.checkApiReadRateLimit(fakeReq(), 'u', 'acme');
        expect(result.ok).toBe(true);
        // No limiter construction, no network call — the kill switch must
        // cost nothing.
        expect(mockRatelimitCtor).not.toHaveBeenCalled();
        expect(mockLimit).not.toHaveBeenCalled();

        delete process.env.RATE_LIMIT_ENABLED;
    });
});
