/**
 * GAP-2 — AI rate limiter, Redis-backed path.
 *
 * Proves the limiter uses the shared ioredis singleton (INCR + EXPIRE
 * on write, GET + PTTL on read) when `getRedis()` returns a client,
 * enforces the tenant/user budgets off the Redis counters, and fails
 * OPEN when Redis throws.
 */
const redis = {
    store: new Map<string, number>(),
    ttl: new Map<string, number>(),
    throwOn: null as null | 'get' | 'incr',
    async get(key: string) {
        if (this.throwOn === 'get') throw new Error('redis down');
        const v = this.store.get(key);
        return v == null ? null : String(v);
    },
    async pttl(key: string) {
        return this.ttl.has(key) ? (this.ttl.get(key) as number) : -2;
    },
    async incr(key: string) {
        if (this.throwOn === 'incr') throw new Error('redis down');
        const next = (this.store.get(key) ?? 0) + 1;
        this.store.set(key, next);
        return next;
    },
    async expire(key: string, seconds: number) {
        this.ttl.set(key, seconds * 1000);
        return 1;
    },
};

jest.mock('@/lib/redis', () => ({ getRedis: () => redis }));

import {
    checkRateLimit,
    recordGeneration,
    getUsageInfo,
    LIMITS,
} from '@/app-layer/ai/risk-assessment/rate-limiter';

beforeEach(() => {
    redis.store.clear();
    redis.ttl.clear();
    redis.throwOn = null;
});

describe('GAP-2 — Redis-backed AI rate limiter', () => {
    it('records via INCR and sets the window TTL on first write', async () => {
        await recordGeneration('tenant-1', 'user-1');
        // tenant daily counter + user rpm counter both created
        expect(redis.store.get('airl:tenant-daily:tenant-1')).toBe(1);
        expect(redis.store.get('airl:user-rpm:tenant-1:user-1')).toBe(1);
        // 24h + 60s windows
        expect(redis.ttl.get('airl:tenant-daily:tenant-1')).toBe(24 * 60 * 60 * 1000);
        expect(redis.ttl.get('airl:user-rpm:tenant-1:user-1')).toBe(60 * 1000);
    });

    it('re-applies the window when a key was left without a TTL, so a lock-out heals (#5305)', async () => {
        // The EXPIRE after the first INCR failed: the counter exists with no TTL.
        redis.store.set('airl:user-rpm:tenant-1:user-1', LIMITS.USER_PER_MINUTE_LIMIT + 3);
        redis.store.set('airl:tenant-daily:tenant-1', 7);
        await recordGeneration('tenant-1', 'user-1');
        expect(redis.ttl.get('airl:user-rpm:tenant-1:user-1')).toBe(60 * 1000);
        expect(redis.ttl.get('airl:tenant-daily:tenant-1')).toBe(24 * 60 * 60 * 1000);
    });

    it('leaves a running window alone — the control', async () => {
        redis.store.set('airl:user-rpm:tenant-1:user-1', 2);
        redis.ttl.set('airl:user-rpm:tenant-1:user-1', 12_345);
        await recordGeneration('tenant-1', 'user-1');
        expect(redis.ttl.get('airl:user-rpm:tenant-1:user-1')).toBe(12_345);
    });

    it('enforces the tenant daily quota off the Redis counter', async () => {
        redis.store.set('airl:tenant-daily:tenant-1', LIMITS.TENANT_DAILY_QUOTA);
        redis.ttl.set('airl:tenant-daily:tenant-1', 3_600_000);
        await expect(checkRateLimit('tenant-1', 'user-x')).rejects.toThrow(/daily limit/i);
    });

    it('enforces the per-user burst off the Redis counter', async () => {
        redis.store.set('airl:user-rpm:tenant-1:user-1', LIMITS.USER_PER_MINUTE_LIMIT);
        await expect(checkRateLimit('tenant-1', 'user-1')).rejects.toThrow(/too many/i);
    });

    it('getUsageInfo reads the tenant counter + derives resetAt from PTTL', async () => {
        redis.store.set('airl:tenant-daily:tenant-1', 7);
        redis.ttl.set('airl:tenant-daily:tenant-1', 5_000);
        const usage = await getUsageInfo('tenant-1');
        expect(usage.used).toBe(7);
        expect(usage.limit).toBe(LIMITS.TENANT_DAILY_QUOTA);
        expect(usage.resetAt).not.toBeNull();
    });

    it('fails OPEN (allows the request) when Redis read throws', async () => {
        redis.throwOn = 'get';
        await expect(checkRateLimit('tenant-1', 'user-1')).resolves.toBeUndefined();
    });
});
