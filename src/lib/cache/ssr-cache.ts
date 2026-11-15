/**
 * SSR payload cache (Redis-backed, origin-tier).
 *
 * Wraps the expensive server-side data fetch a server component does
 * before handing data to its client component, caching the PAYLOAD (not
 * the rendered HTML) per (tenant, route) for a short TTL. A cache hit
 * skips the usecase + DB work entirely; the React render still runs
 * fresh (cheap) so auth context / breadcrumbs stay correct.
 *
 * Invalidation is COARSE on purpose: the key embeds the tenant-WIDE
 * version counter (`tenantVersionKey`). `bumpEntityCacheVersion` bumps it
 * on every write to an aggregation entity (control, risk, evidence, task,
 * test, vendor, …), and the asset and policy usecases bump it directly with
 * `bumpTenantCacheVersion`, since neither has an aggregation entity of its
 * own (#5316). A write path that does neither leaves a cached payload stale
 * for up to its TTL — so a new SSR-cached page needs its entity's writes to
 * bump before its list can be trusted. So a Control write
 * invalidates the dashboard SSR payload (control counts) AND the risks
 * page SSR payload (risk-coverage figures derived from controls) — the
 * right granularity for cross-entity SSR pages. The bump fires before the
 * mutation's response returns, so the staleness window is < 1s.
 *
 * Contrast with `cachedAggregationRead` (per-aggregation, fine-grained
 * dependsOn versions, used in route handlers): this is coarser and
 * tenant-scoped, for server-component page payloads.
 *
 * Fail-open + no-Redis bypass, mirroring the list/aggregation caches:
 * a Redis hiccup or unset `REDIS_URL` falls through to `compute()` so the
 * page always renders and dev/test behave as if uncached.
 *
 * This cache lives at the ORIGIN (Redis) — it cuts server-side TTFB, NOT
 * network round-trip. Edge/CDN HTML caching is a separate tier (and
 * deliberately NOT done for tenant HTML — see docs/cdn.md).
 *
 * Observability: `cache.ssr.hit` / `.miss` / `.duration` (by route).
 */
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';
import { recordSsrCacheHit, recordSsrCacheMiss } from '@/lib/observability/metrics';
import { tenantVersionKey } from '@/lib/cache/list-cache';

const SSR_PREFIX = 'inflect:cache:v1:ssr';
const DEFAULT_TTL_SECONDS = 60;
/** Upper bound — even the most static-feeling tenant payload is bounded. */
export const MAX_SSR_TTL_SECONDS = 300;

export interface CachedSsrOptions<T> {
    /** Tenant scope. The cache is per-tenant; never cache cross-tenant. */
    tenantId: string;
    /** Canonical route name, e.g. 'dashboard', 'risks'. Becomes the metric label + key. */
    route: string;
    /** TTL in seconds (clamped to MAX_SSR_TTL_SECONDS). Default 60. */
    ttlSeconds?: number;
    /** The expensive server-side fetch. Called only on a cache miss. */
    compute: () => Promise<T>;
}

export async function cachedSsrPayload<T>(opts: CachedSsrOptions<T>): Promise<T> {
    const redis = getRedis();
    const start = Date.now();
    if (!redis) {
        // No Redis — bypass, behaviourally identical to uncached.
        return opts.compute();
    }

    const ttl = Math.min(opts.ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_SSR_TTL_SECONDS);

    let version = '0';
    try {
        const stored = await redis.get(tenantVersionKey(opts.tenantId));
        if (stored !== null) version = stored;
    } catch (err) {
        logger.warn('ssr-cache version-read failed', {
            component: 'ssr-cache',
            route: opts.route,
            error: err instanceof Error ? err.message : String(err),
        });
        return opts.compute();
    }

    const cacheKey = `${SSR_PREFIX}:${opts.route}:${opts.tenantId}:tv${version}`;

    // ── HIT ──
    let raw: string | null = null;
    try {
        raw = await redis.get(cacheKey);
    } catch (err) {
        logger.warn('ssr-cache get failed', {
            component: 'ssr-cache',
            route: opts.route,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    if (raw !== null) {
        try {
            const parsed = JSON.parse(raw) as T;
            recordSsrCacheHit(opts.route, Date.now() - start);
            return parsed;
        } catch {
            logger.warn('ssr-cache parse error — refreshing', {
                component: 'ssr-cache',
                route: opts.route,
            });
        }
    }

    // ── MISS ──
    const result = await opts.compute();
    recordSsrCacheMiss(opts.route, Date.now() - start);
    try {
        await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl);
    } catch (err) {
        logger.warn('ssr-cache set failed', {
            component: 'ssr-cache',
            route: opts.route,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    return result;
}
