/**
 * Aggregation-cache coverage ratchet.
 *
 * The aggregation cache (src/lib/cache/aggregation-cache.ts) is only
 * correct if three invariants hold, all enforced here:
 *
 *   1. Every heavy-read dashboard/metric route actually goes through
 *      `cachedAggregationRead` — otherwise it recomputes on every hit.
 *   2. Every entity any aggregation `dependsOn` is bumped by at least
 *      one usecase — otherwise that aggregation never invalidates when
 *      the entity changes (it would silently serve stale data up to the
 *      TTL, defeating the bump-on-write contract).
 *   3. TTLs are bounded — a runaway TTL would mask a broken bump as a
 *      "merely stale" dashboard for far too long.
 *
 * See docs/response-caching.md for the contract.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    AGGREGATIONS,
    MAX_AGGREGATION_TTL_SECONDS,
    type AggregationEntity,
    type AggregationName,
} from '@/lib/cache/aggregation-registry';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

// Each aggregation → the route file that must wrap its compute.
const ROUTE_FILES: Record<AggregationName, string> = {
    'controls-dashboard': 'src/app/api/t/[tenantSlug]/controls/dashboard/route.ts',
    'risks-dashboard': 'src/app/api/t/[tenantSlug]/risks/dashboard/route.ts',
    'tests-dashboard': 'src/app/api/t/[tenantSlug]/tests/dashboard/route.ts',
    'vendors-metrics': 'src/app/api/t/[tenantSlug]/vendors/metrics/route.ts',
    'tasks-metrics': 'src/app/api/t/[tenantSlug]/tasks/metrics/route.ts',
    // `issues-metrics` was the /issues alias of `tasks-metrics` and was deleted
    // with the rest of the parallel surface — same usecase, same cache key,
    // second URL.
    'audits-readiness-overview': 'src/app/api/t/[tenantSlug]/audits/readiness/overview/route.ts',
    'loss-events-aggregate': 'src/app/api/t/[tenantSlug]/loss-events/aggregate/route.ts',
    'org-dashboard-widgets': 'src/app/api/org/[orgSlug]/dashboard/widgets/route.ts',
};

/** All .ts under src/app-layer (where bumps live). */
function appLayerSources(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) walk(abs);
            else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(abs);
        }
    };
    walk(path.join(ROOT, 'src/app-layer'));
    return out;
}

describe('aggregation-cache coverage', () => {
    it('the aggregation registry module exists', () => {
        expect(exists('src/lib/cache/aggregation-registry.ts')).toBe(true);
        expect(exists('src/lib/cache/aggregation-cache.ts')).toBe(true);
    });

    it('every aggregation has a route mapping (registry ↔ routes in sync)', () => {
        const names = Object.keys(AGGREGATIONS) as AggregationName[];
        const mapped = Object.keys(ROUTE_FILES);
        expect(names.sort()).toEqual(mapped.sort());
    });

    describe('every dashboard route uses cachedAggregationRead', () => {
        for (const [name, file] of Object.entries(ROUTE_FILES)) {
            it(`${name} → ${file}`, () => {
                expect(exists(file)).toBe(true);
                const src = read(file);
                expect(src).toMatch(/cachedAggregationRead\s*\(/);
                // and references its own registry key
                expect(src).toContain(`'${name}'`);
            });
        }
    });

    describe('every dependsOn entity is bumped by at least one usecase', () => {
        const allSources = appLayerSources().map((f) => fs.readFileSync(f, 'utf8'));
        const blob = allSources.join('\n');

        // Union of every entity referenced across all aggregations.
        const entities = new Set<AggregationEntity>();
        for (const spec of Object.values(AGGREGATIONS)) {
            for (const e of spec.dependsOn) entities.add(e);
        }

        for (const entity of entities) {
            it(`'${entity}' is bumped somewhere in src/app-layer`, () => {
                // Matches bumpEntityCacheVersion(ctx, 'entity') OR
                // bumpEntityCacheVersionForScope(scope, 'entity').
                const re = new RegExp(
                    `bumpEntityCacheVersion(?:ForScope)?\\([^)]*['"]${entity}['"]`,
                );
                expect(re.test(blob)).toBe(true);
            });
        }
    });

    it('every aggregation TTL is bounded (≤ MAX_AGGREGATION_TTL_SECONDS)', () => {
        const tooLong = Object.entries(AGGREGATIONS)
            .filter(([, spec]) => spec.ttlSeconds > MAX_AGGREGATION_TTL_SECONDS)
            .map(([name]) => name);
        expect(tooLong).toEqual([]);
        expect(MAX_AGGREGATION_TTL_SECONDS).toBeLessThanOrEqual(600);
    });
});
