/**
 * AI Risk Assessment — Rate Limiter
 *
 * Shared-store rate limiting for AI generation requests. Limits by
 * tenant (daily quota) and by user (per-minute burst).
 *
 * GAP-2 — moved from a process-local `Map` to the shared ioredis
 * singleton (`@/lib/redis`) so the quota is correct across every
 * replica of a multi-instance deployment. When Redis is not
 * configured (local dev / CI / single-instance self-host) it falls
 * back transparently to an in-process `Map` — same behaviour as
 * before, no config required.
 *
 * Fail-open posture (matches `credential-rate-limit.ts` /
 * `apiReadRateLimit.ts`): a Redis outage must not brick AI features
 * fleet-wide, so a store error lets the request through and logs it.
 *
 * The check/record split is deliberate and unchanged: `checkRateLimit`
 * reads the counters BEFORE generation; `recordGeneration` increments
 * them only AFTER a successful generation, so a failed provider call
 * doesn't consume quota. The two steps are not atomic — under a burst
 * two concurrent callers can both pass the check before either records,
 * a bounded overshoot of at most (concurrency − 1). That is acceptable
 * for a 50/day + 5/min budget and matches the prior in-memory semantics.
 */
import { rateLimited } from '@/lib/errors/types';
import { env } from '@/env';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';

// ─── Configuration ───

/** Max AI generation requests per tenant per day */
const TENANT_DAILY_QUOTA = parseInt(env.AI_RISK_DAILY_QUOTA ?? '50', 10);

/** Max AI generation requests per user per minute (burst protection) */
const USER_PER_MINUTE_LIMIT = parseInt(env.AI_RISK_USER_RPM ?? '5', 10);

const ONE_DAY_SECONDS = 24 * 60 * 60;
const ONE_MINUTE_SECONDS = 60;

const KEY_PREFIX = 'airl';
const tenantKey = (tenantId: string) => `${KEY_PREFIX}:tenant-daily:${tenantId}`;
const userKey = (tenantId: string, userId: string) => `${KEY_PREFIX}:user-rpm:${tenantId}:${userId}`;

// ─── In-Memory Fallback Store ───
//
// Used only when `getRedis()` returns null (no REDIS_URL). Keyed by the
// SAME string keys as the Redis path so both stores share one key shape.

interface RateBucket {
    count: number;
    resetAt: number; // Unix timestamp in ms
}

const memoryBuckets = new Map<string, RateBucket>();

function memoryPeek(key: string): { count: number; ttlMs: number } {
    const now = Date.now();
    const existing = memoryBuckets.get(key);
    if (existing && existing.resetAt > now) {
        return { count: existing.count, ttlMs: existing.resetAt - now };
    }
    return { count: 0, ttlMs: 0 };
}

function memoryIncr(key: string, windowSeconds: number): void {
    const now = Date.now();
    const existing = memoryBuckets.get(key);
    if (existing && existing.resetAt > now) {
        existing.count += 1;
        return;
    }
    memoryBuckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
}

// ─── Store abstraction (Redis with memory fallback) ───

/** Read the current count + remaining TTL (ms) for a key. Fail-open → count 0. */
async function peek(key: string): Promise<{ count: number; ttlMs: number }> {
    const redis = getRedis();
    if (!redis) return memoryPeek(key);
    try {
        const [countStr, pttl] = await Promise.all([redis.get(key), redis.pttl(key)]);
        const count = countStr ? parseInt(countStr, 10) : 0;
        // pttl: -2 = no key, -1 = no expiry. Clamp non-positive to 0.
        return { count: Number.isNaN(count) ? 0 : count, ttlMs: pttl > 0 ? pttl : 0 };
    } catch (err) {
        logger.error('AI rate-limit peek failed, failing open', {
            component: 'ai-rate-limit',
            err: err instanceof Error ? err : new Error(String(err)),
        });
        return { count: 0, ttlMs: 0 };
    }
}

/** Increment a counter, setting the window TTL on the first write. */
async function incr(key: string, windowSeconds: number): Promise<void> {
    const redis = getRedis();
    if (!redis) {
        memoryIncr(key, windowSeconds);
        return;
    }
    try {
        const count = await redis.incr(key);
        if (count === 1) {
            // First increment starts the rolling window.
            await redis.expire(key, windowSeconds);
        } else if ((await redis.pttl(key)) < 0) {
            // A key with no TTL never resets (#5305). If the EXPIRE after the
            // first INCR failed (a transient Redis error between the two), the
            // counter kept climbing past the limit and refused that user or
            // tenant every AI call for ever. Re-apply the window whenever a
            // later increment finds none, so the lock-out heals itself.
            await redis.expire(key, windowSeconds);
        }
    } catch (err) {
        logger.error('AI rate-limit incr failed, skipping record', {
            component: 'ai-rate-limit',
            err: err instanceof Error ? err : new Error(String(err)),
        });
    }
}

// ─── Rate Check ───

/**
 * Check rate limits for an AI generation request.
 * Throws `rateLimited` AppError (HTTP 429) if limits are exceeded.
 *
 * Call this BEFORE generating suggestions.
 */
export async function checkRateLimit(tenantId: string, userId: string): Promise<void> {
    // 1. Tenant daily quota
    const tenant = await peek(tenantKey(tenantId));
    if (tenant.count >= TENANT_DAILY_QUOTA) {
        const resetIn = Math.max(1, Math.ceil(tenant.ttlMs / 1000 / 60));
        throw rateLimited(
            `AI assessment daily limit reached (${TENANT_DAILY_QUOTA}/day). Resets in ~${resetIn} minutes.`
        );
    }

    // 2. User per-minute burst limit
    const user = await peek(userKey(tenantId, userId));
    if (user.count >= USER_PER_MINUTE_LIMIT) {
        throw rateLimited(
            `Too many AI assessment requests. Please wait a moment before trying again.`
        );
    }
}

/**
 * Record a successful generation (increment counters).
 * Call this AFTER a successful generation.
 */
export async function recordGeneration(tenantId: string, userId: string): Promise<void> {
    await incr(tenantKey(tenantId), ONE_DAY_SECONDS);
    await incr(userKey(tenantId, userId), ONE_MINUTE_SECONDS);
}

/**
 * Get current usage info for a tenant (for UI display).
 */
export async function getUsageInfo(
    tenantId: string,
): Promise<{ used: number; limit: number; resetAt: number | null }> {
    const { count, ttlMs } = await peek(tenantKey(tenantId));
    if (count <= 0) {
        return { used: 0, limit: TENANT_DAILY_QUOTA, resetAt: null };
    }
    return {
        used: count,
        limit: TENANT_DAILY_QUOTA,
        resetAt: ttlMs > 0 ? Date.now() + ttlMs : null,
    };
}

/**
 * Reset rate limits (for testing). Clears only the in-memory fallback
 * store — Redis-backed tests should use unique tenant/user ids per case.
 */
export function _resetForTesting(): void {
    memoryBuckets.clear();
}

// Export constants for test assertions
export const LIMITS = {
    TENANT_DAILY_QUOTA,
    USER_PER_MINUTE_LIMIT,
} as const;
