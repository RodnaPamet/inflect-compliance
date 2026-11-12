/**
 * Tests for the Redis-backed aggregation cache.
 *
 * Mocks ioredis with ioredis-mock so the real command logic (GET / SET /
 * EX / MGET / INCR) runs in-process. Coverage:
 *   • miss runs compute once, then subsequent reads hit;
 *   • a bump to ANY dependsOn entity invalidates → next read misses;
 *   • a bump to an UNRELATED entity does NOT invalidate;
 *   • different scopeKey → isolated entries;
 *   • different params → different entries;
 *   • no-Redis fallback computes every time, never caches;
 *   • the caller's authorize runs on every read, a hit included, and a
 *     refusal reads nothing.
 */
jest.mock('ioredis', () => require('ioredis-mock'));
process.env.REDIS_URL = 'redis://localhost:6379';

import { cachedAggregationRead } from '@/lib/cache/aggregation-cache';
import { bumpEntityCacheVersionForScope } from '@/lib/cache/list-cache';
import { getRedis, disconnectRedis } from '@/lib/redis';

beforeEach(async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const redis = getRedis();
    if (redis) await redis.flushall();
});

afterAll(async () => {
    await disconnectRedis();
});

const baseOpts = {
    scopeKey: 't1',
    aggregation: 'controls-dashboard',
    dependsOn: ['control', 'task'] as const,
    ttlSeconds: 60,
    authorize: () => undefined,
};

it('miss computes once, then reads hit the cache', async () => {
    let calls = 0;
    const compute = async () => { calls++; return { n: calls }; };

    const a = await cachedAggregationRead({ ...baseOpts, compute });
    const b = await cachedAggregationRead({ ...baseOpts, compute });

    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 }); // served from cache, compute not re-run
    expect(calls).toBe(1);
});

it('a bump to a dependsOn entity invalidates the entry', async () => {
    let calls = 0;
    const compute = async () => { calls++; return { n: calls }; };

    await cachedAggregationRead({ ...baseOpts, compute }); // miss → 1
    await bumpEntityCacheVersionForScope('t1', 'task');    // invalidate
    const after = await cachedAggregationRead({ ...baseOpts, compute }); // miss → 2

    expect(after).toEqual({ n: 2 });
    expect(calls).toBe(2);
});

it('a bump to an UNRELATED entity does not invalidate', async () => {
    let calls = 0;
    const compute = async () => { calls++; return { n: calls }; };

    await cachedAggregationRead({ ...baseOpts, compute }); // miss → 1
    await bumpEntityCacheVersionForScope('t1', 'vendor');  // not in dependsOn
    await cachedAggregationRead({ ...baseOpts, compute }); // still a hit

    expect(calls).toBe(1);
});

it('different scopeKey gets an isolated entry', async () => {
    let calls = 0;
    const compute = async () => { calls++; return { n: calls }; };

    await cachedAggregationRead({ ...baseOpts, scopeKey: 't1', compute });
    await cachedAggregationRead({ ...baseOpts, scopeKey: 't2', compute });

    expect(calls).toBe(2); // each scope computed independently
});

it('different params get different entries', async () => {
    let calls = 0;
    const compute = async () => { calls++; return { n: calls }; };

    await cachedAggregationRead({ ...baseOpts, variant: { period: 30 }, compute });
    await cachedAggregationRead({ ...baseOpts, variant: { period: 90 }, compute });
    await cachedAggregationRead({ ...baseOpts, variant: { period: 30 }, compute }); // hit

    expect(calls).toBe(2);
});

it('no-Redis fallback computes every time and never caches', async () => {
    delete process.env.REDIS_URL;
    await disconnectRedis();
    let calls = 0;
    const compute = async () => { calls++; return { n: calls }; };

    await cachedAggregationRead({ ...baseOpts, compute });
    await cachedAggregationRead({ ...baseOpts, compute });

    expect(calls).toBe(2);
});

it('runs authorize on a cache hit too, and a refusal never reaches the cached answer', async () => {
    const compute = async () => ({ secret: 'aggregate' });
    // An authorised caller fills the cache.
    await cachedAggregationRead({ ...baseOpts, compute });

    const authorize = jest.fn(() => {
        throw new Error('forbidden: no controls.view');
    });
    const refusedCompute = jest.fn(compute);
    await expect(
        cachedAggregationRead({ ...baseOpts, authorize, compute: refusedCompute }),
    ).rejects.toThrow(/forbidden/);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(refusedCompute).not.toHaveBeenCalled();
});

it('runs authorize when there is no Redis', async () => {
    await disconnectRedis();
    delete process.env.REDIS_URL;
    const authorize = jest.fn(() => {
        throw new Error('forbidden');
    });
    const compute = jest.fn(async () => ({ n: 1 }));
    await expect(cachedAggregationRead({ ...baseOpts, authorize, compute })).rejects.toThrow(/forbidden/);
    expect(compute).not.toHaveBeenCalled();
});
