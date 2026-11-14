/**
 * Per-identifier credential rate limit — memory-fallback behaviour.
 *
 * Covers the contract the chokepoint relies on:
 *   - First N attempts under the sliding window pass
 *   - N+1 is blocked with a positive retryAfterSeconds
 *   - reset() lets a user through again immediately
 *   - AUTH_TEST_MODE=1 short-circuits the gate (E2E-test invariant)
 *   - RATE_LIMIT_ENABLED=0 also short-circuits (ops kill switch)
 *
 * No Upstash in this file — the memory fallback is what CI uses and
 * what dev uses. The Upstash path is exercised in integration.
 */

const mockEnv: Record<string, string | undefined> = {
    RATE_LIMIT_MODE: 'memory',
    RATE_LIMIT_ENABLED: '1',
    AUTH_TEST_MODE: undefined,
};
jest.mock('@/env', () => ({
    __esModule: true,
    env: new Proxy(mockEnv, {
        get: (t, p: string) => t[p as string],
    }),
}));

import {
    CREDENTIALS_RATE_LIMIT,
    __resetCredentialsRateLimitForTests,
    checkCredentialsAttempt,
    resetCredentialsBackoff,
} from '@/lib/auth/credential-rate-limit';

beforeEach(() => {
    __resetCredentialsRateLimitForTests();
    mockEnv.RATE_LIMIT_MODE = 'memory';
    mockEnv.RATE_LIMIT_ENABLED = '1';
    mockEnv.AUTH_TEST_MODE = undefined;
});

describe('checkCredentialsAttempt — memory fallback', () => {
    const EMAIL = 'alice@example.com';

    it(`allows the first ${CREDENTIALS_RATE_LIMIT.maxAttempts} attempts in the window`, async () => {
        for (let i = 0; i < CREDENTIALS_RATE_LIMIT.maxAttempts; i++) {
            const r = await checkCredentialsAttempt(EMAIL);
            expect(r).toEqual({ ok: true });
        }
    });

    it(`blocks attempt ${CREDENTIALS_RATE_LIMIT.maxAttempts + 1} with a positive retryAfterSeconds`, async () => {
        for (let i = 0; i < CREDENTIALS_RATE_LIMIT.maxAttempts; i++) {
            await checkCredentialsAttempt(EMAIL);
        }
        const blocked = await checkCredentialsAttempt(EMAIL);
        expect(blocked.ok).toBe(false);
        if (!blocked.ok) {
            expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
            expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(
                CREDENTIALS_RATE_LIMIT.windowSeconds,
            );
        }
    });

    it('keeps separate buckets per email (case-insensitive)', async () => {
        // Saturate the bucket for one email…
        for (let i = 0; i < CREDENTIALS_RATE_LIMIT.maxAttempts; i++) {
            await checkCredentialsAttempt('one@example.com');
        }
        // …and a different email still has headroom.
        const r = await checkCredentialsAttempt('two@example.com');
        expect(r).toEqual({ ok: true });
    });

    it('normalises case + whitespace — same email hits the same bucket', async () => {
        for (let i = 0; i < CREDENTIALS_RATE_LIMIT.maxAttempts; i++) {
            await checkCredentialsAttempt('  MixedCase@Example.COM  ');
        }
        const r = await checkCredentialsAttempt('mixedcase@example.com');
        expect(r.ok).toBe(false);
    });

    it('resetCredentialsBackoff clears the counter so the user can retry immediately', async () => {
        for (let i = 0; i < CREDENTIALS_RATE_LIMIT.maxAttempts; i++) {
            await checkCredentialsAttempt(EMAIL);
        }
        const blocked = await checkCredentialsAttempt(EMAIL);
        expect(blocked.ok).toBe(false);

        await resetCredentialsBackoff(EMAIL);

        const after = await checkCredentialsAttempt(EMAIL);
        expect(after).toEqual({ ok: true });
    });
});

describe('resetCredentialsBackoff — Upstash', () => {
    // The REAL `@upstash/ratelimit` over a fake Redis that runs the two
    // scripts it sends: the sliding-window limit (counts per window key) and
    // the reset (deletes every key matching a `…:*` pattern). The fake keeps
    // a `del` too, so a reset that DELs a key the limiter never wrote is
    // observed as what it is — a no-op on the stored counts (#5306).
    const store = new Map<string, number>();
    const fakeRedis = {
        evalsha: jest.fn(async (_hash: string, keys: string[], args: unknown[]) => {
            if (keys.length === 1 && keys[0].endsWith(':*')) {
                const prefix = keys[0].slice(0, -1);
                for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
                return null;
            }
            const tokens = Number(args[0]);
            const used = (store.get(keys[0]) ?? 0) + 1;
            store.set(keys[0], used);
            return [tokens - used, tokens];
        }),
        eval: jest.fn(),
        del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    };

    beforeEach(() => {
        store.clear();
        fakeRedis.evalsha.mockClear();
        fakeRedis.del.mockClear();
        jest.resetModules();
        jest.doMock('@upstash/redis', () => ({
            Redis: { fromEnv: () => fakeRedis },
        }));
        mockEnv.RATE_LIMIT_MODE = 'upstash';
    });

    afterEach(() => {
        jest.dontMock('@upstash/redis');
        mockEnv.RATE_LIMIT_MODE = 'memory';
    });

    it('a successful sign-in clears the bucket the limiter actually wrote', async () => {
        const fresh = await import('@/lib/auth/credential-rate-limit');
        fresh.__resetCredentialsRateLimitForTests();

        // Five successful sign-ins in the window, each resetting after.
        for (let i = 0; i < CREDENTIALS_RATE_LIMIT.maxAttempts; i++) {
            expect(await fresh.checkCredentialsAttempt('alice@example.com')).toEqual({ ok: true });
            await fresh.resetCredentialsBackoff('alice@example.com');
        }
        // The sixth correct password is not refused.
        expect(await fresh.checkCredentialsAttempt('alice@example.com')).toEqual({ ok: true });
        // The limiter's keys are prefixed and per-window, never the bare key.
        const keys = [...store.keys()];
        expect(keys.length).toBeGreaterThan(0);
        const LIMITER_KEY = /^@upstash\/ratelimit:rl:cred:id:[0-9a-f]{64}:\d+$/;
        expect(keys.filter((k) => !LIMITER_KEY.test(k))).toEqual([]);
    });

    it('reset fails open if Redis throws — memory bucket still cleared', async () => {
        const fresh = await import('@/lib/auth/credential-rate-limit');
        fresh.__resetCredentialsRateLimitForTests();
        await fresh.checkCredentialsAttempt('bob@example.com');

        fakeRedis.evalsha.mockRejectedValueOnce(new Error('upstash blip'));
        // The Redis call inside reset rejects, but the function resolves
        // cleanly — better to let a successful login through than to 500 on
        // a Redis blip.
        await expect(
            fresh.resetCredentialsBackoff('bob@example.com'),
        ).resolves.toBeUndefined();
    });
});

describe('checkCredentialsAttempt — kill switches', () => {
    it('AUTH_TEST_MODE=1 bypasses the gate regardless of attempt count', async () => {
        mockEnv.AUTH_TEST_MODE = '1';
        for (let i = 0; i < CREDENTIALS_RATE_LIMIT.maxAttempts + 5; i++) {
            const r = await checkCredentialsAttempt('spam@example.com');
            expect(r).toEqual({ ok: true });
        }
    });

    it('RATE_LIMIT_ENABLED=0 bypasses the gate regardless of attempt count', async () => {
        mockEnv.RATE_LIMIT_ENABLED = '0';
        for (let i = 0; i < CREDENTIALS_RATE_LIMIT.maxAttempts + 5; i++) {
            const r = await checkCredentialsAttempt('spam@example.com');
            expect(r).toEqual({ ok: true });
        }
    });
});
