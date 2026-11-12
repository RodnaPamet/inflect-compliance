/**
 * Aggregation read cache (Redis-backed).
 *
 * Dashboards/metrics aggregate across many entities, so caching them is
 * a different problem from list caching (`list-cache.ts`):
 *
 *   • **Cross-entity invalidation.** The cache key composes the version
 *     counters of EVERY entity in `dependsOn` (from the aggregation
 *     registry). A write that calls `bumpEntityCacheVersion(ctx, e)` for
 *     any `e` in the list changes the composed version → the next read
 *     recomputes. Same version-counter namespace as the list cache, so a
 *     single bump invalidates both.
 *
 *   • **TTL is the staleness ceiling, bumps are the primary mechanism.**
 *     Default per-aggregation TTL bounds worst-case staleness if a write
 *     path forgets to bump (the ratchet catches the obvious cases; a raw
 *     `$executeRaw` write is the residual risk — code review is the
 *     backstop). See docs/response-caching.md.
 *
 *   • **Tenant/org-scoped, NOT user-scoped.** The key includes the scope
 *     id (tenantId, or organizationId for org aggregations) but no
 *     userId — two users in the same tenant share the cached aggregate.
 *     Do NOT cache per-user payloads at this layer (use
 *     `cachedDashboardRead`, which keys on userId, for those).
 *
 *   • **Fail-open + no-Redis bypass**, mirroring `cachedListRead`: a
 *     Redis hiccup or an unconfigured `REDIS_URL` falls through to
 *     `compute()` so the API never breaks and dev/test behave as if
 *     uncached.
 *
 * Observability: emits `cache.aggregation.hit` / `.miss` /
 * `.compute_duration_ms` (labelled by aggregation) via
 * `src/lib/observability/metrics.ts`.
 */
import { createHash } from 'node:crypto';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';
import {
    recordAggregationCacheHit,
    recordAggregationCacheMiss,
} from '@/lib/observability/metrics';
import { entityVersionKey, stableStringify } from '@/lib/cache/list-cache';
import type { AggregationEntity } from '@/lib/cache/aggregation-registry';

const AGG_PREFIX = 'inflect:cache:v1:agg';
const DEFAULT_TTL_SECONDS = 60;

export interface CachedAggregationOptions<T> {
    /** Cache scope id: `ctx.tenantId` for tenant aggregations, `ctx.organizationId` for org ones. */
    scopeKey: string;
    /** Stable identifier for the aggregation — the registry key (also the metric label). */
    aggregation: string;
    /** Entities whose version counters key this read. A bump on any invalidates it. */
    dependsOn: ReadonlyArray<AggregationEntity>;
    /** Hard staleness cap in seconds. Default 60. */
    ttlSeconds?: number;
    /**
     * Query inputs that distinguish results (e.g. `{ period }`, `{ riskId }`).
     * Hashed into the key so different inputs get different entries. Omit
     * for parameterless aggregations. (Named `variant`, not `params`, to
     * stay clear of the async-params route-typing guard.)
     */
    variant?: unknown;
    /**
     * The caller's read check, run on EVERY call before the cache is read —
     * a hit included. `compute` runs only on a miss, so a check that lived
     * only inside it would be skipped whenever the answer was cached, and a
     * caller refused on a cold cache would read what an authorised caller had
     * just cached. Throw to refuse. Required, so a new caller cannot forget it.
     */
    authorize: () => void | Promise<void>;
    /** The expensive aggregation. Called only on a cache miss. */
    compute: () => Promise<T>;
}

export async function cachedAggregationRead<T>(opts: CachedAggregationOptions<T>): Promise<T> {
    await opts.authorize();
    const redis = getRedis();
    if (!redis) {
        // No Redis — bypass cache, behaviourally identical to uncached.
        return opts.compute();
    }

    const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    // Compose the version counters of every dependency into the key.
    // A bump to any of them changes the composed string → cache miss.
    let versions: (string | null)[];
    try {
        const versionKeys = opts.dependsOn.map((e) => entityVersionKey(opts.scopeKey, e));
        versions = versionKeys.length ? await redis.mget(...versionKeys) : [];
    } catch (err) {
        logger.warn('aggregation-cache version-read failed', {
            component: 'aggregation-cache',
            aggregation: opts.aggregation,
            error: err instanceof Error ? err.message : String(err),
        });
        return opts.compute();
    }
    const composedVersion = opts.dependsOn
        .map((e, i) => `${e}=${versions[i] ?? '0'}`)
        .join(',');

    const paramHash = createHash('sha256')
        .update(stableStringify(opts.variant ?? null))
        .digest('hex')
        .slice(0, 16);

    const cacheKey = `${AGG_PREFIX}:${opts.aggregation}:${opts.scopeKey}:v[${composedVersion}]:${paramHash}`;

    // ── HIT path ──
    let raw: string | null = null;
    try {
        raw = await redis.get(cacheKey);
    } catch (err) {
        logger.warn('aggregation-cache get failed', {
            component: 'aggregation-cache',
            aggregation: opts.aggregation,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    if (raw !== null) {
        try {
            const parsed = JSON.parse(raw) as T;
            recordAggregationCacheHit(opts.aggregation);
            logger.debug('aggregation-cache hit', {
                component: 'aggregation-cache',
                aggregation: opts.aggregation,
                scopeKey: opts.scopeKey,
            });
            return parsed;
        } catch {
            // Corrupted entry — fall through; the `set` below overwrites it.
            logger.warn('aggregation-cache parse error — refreshing', {
                component: 'aggregation-cache',
                aggregation: opts.aggregation,
            });
        }
    }

    // ── MISS path ──
    const loadStart = Date.now();
    const result = await opts.compute();
    const computeMs = Date.now() - loadStart;
    recordAggregationCacheMiss(opts.aggregation, computeMs);

    try {
        await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl);
    } catch (err) {
        logger.warn('aggregation-cache set failed', {
            component: 'aggregation-cache',
            aggregation: opts.aggregation,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    logger.debug('aggregation-cache miss', {
        component: 'aggregation-cache',
        aggregation: opts.aggregation,
        computeMs,
        scopeKey: opts.scopeKey,
    });

    return result;
}
