/**
 * Epic 69 — typed SWR cache-key registry pins.
 *
 * Two complementary checks:
 *
 *   1. **Behavioural** — every method below produces the expected
 *      tenant-relative path. Catches drift between the registry and
 *      the API routes when someone renames an endpoint without
 *      updating the constant.
 *
 *   2. **Structural** — convention sanity (every key starts with
 *      `/`, no trailing slash, no double slash, no leaked
 *      `/api/t/{slug}` prefix). Catches a class of mistakes the
 *      compiler can't see.
 *
 * Together these are cheap insurance: a registry that drifts from
 * its endpoints is worse than no registry at all because it produces
 * silent cache-misses.
 */
import { CACHE_KEYS } from '@/lib/swr-keys';

describe('CACHE_KEYS — key construction', () => {
    describe('controls', () => {
        it('list() → /controls', () => {
            expect(CACHE_KEYS.controls.list()).toBe('/controls');
        });
        it('detail(id) interpolates the id', () => {
            expect(CACHE_KEYS.controls.detail('c1')).toBe('/controls/c1');
        });
        it('exposes the dashboard sub-view', () => {
            expect(CACHE_KEYS.controls.dashboard()).toBe('/controls/dashboard');
        });
        it('exposes templates and consistencyCheck', () => {
            expect(CACHE_KEYS.controls.templates()).toBe('/controls/templates');
            expect(CACHE_KEYS.controls.consistencyCheck()).toBe(
                '/controls/consistency-check',
            );
        });
    });

    describe('risks', () => {
        it('list() → /risks; detail(id) → /risks/{id}', () => {
            expect(CACHE_KEYS.risks.list()).toBe('/risks');
            expect(CACHE_KEYS.risks.detail('r9')).toBe('/risks/r9');
        });
    });

    describe('evidence', () => {
        it('list / detail / metrics / files / retention shape', () => {
            expect(CACHE_KEYS.evidence.list()).toBe('/evidence');
            expect(CACHE_KEYS.evidence.detail('e1')).toBe('/evidence/e1');
            expect(CACHE_KEYS.evidence.metrics()).toBe('/evidence/metrics');
            expect(CACHE_KEYS.evidence.files()).toBe('/evidence/files');
            expect(CACHE_KEYS.evidence.retention()).toBe('/evidence/retention');
        });
    });

    describe('policies', () => {
        it('list / detail / templates', () => {
            expect(CACHE_KEYS.policies.list()).toBe('/policies');
            expect(CACHE_KEYS.policies.detail('p1')).toBe('/policies/p1');
            expect(CACHE_KEYS.policies.templates()).toBe('/policies/templates');
        });
    });

    describe('tasks', () => {
        it('list / detail / metrics', () => {
            expect(CACHE_KEYS.tasks.list()).toBe('/tasks');
            expect(CACHE_KEYS.tasks.detail('t1')).toBe('/tasks/t1');
            expect(CACHE_KEYS.tasks.metrics()).toBe('/tasks/metrics');
        });
    });

    describe('vendors', () => {
        it('list / detail / metrics', () => {
            expect(CACHE_KEYS.vendors.list()).toBe('/vendors');
            expect(CACHE_KEYS.vendors.detail('v1')).toBe('/vendors/v1');
            expect(CACHE_KEYS.vendors.metrics()).toBe('/vendors/metrics');
        });
    });

    describe('assets', () => {
        it('list / detail', () => {
            expect(CACHE_KEYS.assets.list()).toBe('/assets');
            expect(CACHE_KEYS.assets.detail('a1')).toBe('/assets/a1');
        });
    });

    describe('audits', () => {
        it('list / detail / readiness / cycles / packs', () => {
            expect(CACHE_KEYS.audits.list()).toBe('/audits');
            expect(CACHE_KEYS.audits.detail('au1')).toBe('/audits/au1');
            expect(CACHE_KEYS.audits.readiness()).toBe('/audits/readiness');
            expect(CACHE_KEYS.audits.readinessOverview()).toBe(
                '/audits/readiness/overview',
            );
            expect(CACHE_KEYS.audits.cycles()).toBe('/audits/cycles');
            expect(CACHE_KEYS.audits.packs()).toBe('/audits/packs');
        });

        // Grouped under `audits` because that is where the SCREEN lives, but
        // the API route is `/api/t/{slug}/business-continuity` — no `/audits`
        // segment. Both keys used to carry one, pointing at a URL with no
        // route behind it. Pinned so the navigation path cannot be pasted
        // back over the API path: the resulting read 404s and the resulting
        // mutation updates an entry nothing renders, neither of which fails
        // loudly.
        it('business continuity keys follow the API path, not the nav path', () => {
            expect(CACHE_KEYS.audits.businessContinuity()).toBe(
                '/business-continuity',
            );
            expect(CACHE_KEYS.audits.bia('bia1')).toBe(
                '/business-continuity/bia1',
            );
        });
    });

    describe('dashboard / coverage / cross-cutting', () => {
        it('dashboard home/executive/trends', () => {
            expect(CACHE_KEYS.dashboard.home()).toBe('/dashboard');
            expect(CACHE_KEYS.dashboard.executive()).toBe('/dashboard/executive');
            // The query window is baked into the key so a mutate() matches
            // the live entry the dashboard reads (`?days=30` default).
            expect(CACHE_KEYS.dashboard.trends()).toBe('/dashboard/trends?days=30');
            expect(CACHE_KEYS.dashboard.trends(7)).toBe('/dashboard/trends?days=7');
        });
        it('coverage home', () => {
            expect(CACHE_KEYS.coverage.home()).toBe('/coverage');
        });
        it('audit log / notifications / search / traceability', () => {
            expect(CACHE_KEYS.auditLog.list()).toBe('/audit-log');
            expect(CACHE_KEYS.notifications.list()).toBe('/notifications');
            expect(CACHE_KEYS.notifications.settings()).toBe(
                '/notification-settings',
            );
            expect(CACHE_KEYS.search.query()).toBe('/search');
            expect(CACHE_KEYS.traceability.graph()).toBe('/traceability');
        });
    });
});

describe('CACHE_KEYS — convention sanity', () => {
    /**
     * Walk every method on the registry, call it with a placeholder
     * if it takes an arg, and assert the returned key obeys the
     * tenant-relative format documented in the module header.
     *
     * This is intentionally a STRUCTURAL test, not a pinned-string
     * one — it catches whole classes of drift (leading slash,
     * trailing slash, leaked `/api/t/{slug}` prefix) without
     * needing to be updated each time someone adds a new method to
     * an existing resource.
     */
    function* allKeys(): Generator<{ path: string; method: string }> {
        for (const [resource, methods] of Object.entries(CACHE_KEYS)) {
            for (const [name, fn] of Object.entries(
                methods as Record<string, (...args: string[]) => string>,
            )) {
                if (typeof fn !== 'function') continue;
                // Pass a placeholder id; methods that ignore it
                // still produce the right shape.
                const path = fn('placeholder');
                yield { path, method: `${resource}.${name}` };
            }
        }
    }

    it('every key starts with a single leading slash', () => {
        const violations: string[] = [];
        for (const { path, method } of allKeys()) {
            if (!path.startsWith('/') || path.startsWith('//')) {
                violations.push(`${method} → ${path}`);
            }
        }
        expect(violations).toEqual([]);
    });

    it('no key has a trailing slash', () => {
        const violations: string[] = [];
        for (const { path, method } of allKeys()) {
            if (path.length > 1 && path.endsWith('/')) {
                violations.push(`${method} → ${path}`);
            }
        }
        expect(violations).toEqual([]);
    });

    it('no key contains the /api/t/ prefix (that belongs to the hook layer)', () => {
        const violations: string[] = [];
        for (const { path, method } of allKeys()) {
            if (path.includes('/api/t/') || path.startsWith('/api/')) {
                violations.push(`${method} → ${path}`);
            }
        }
        expect(violations).toEqual([]);
    });

    it('no key contains a double slash', () => {
        const violations: string[] = [];
        for (const { path, method } of allKeys()) {
            // skip the leading `/` then look for any `//`
            if (path.slice(1).includes('//')) {
                violations.push(`${method} → ${path}`);
            }
        }
        expect(violations).toEqual([]);
    });
});

/**
 * The registry is almost entirely branch-free string interpolation — except
 * for the two methods that assemble a QUERY STRING conditionally. Those are
 * the only places where a key can silently stop matching the URL the page
 * actually fetches, which is the exact near-miss the registry exists to
 * prevent (a `mutate()` on a key nothing reads is a no-op with no error).
 * The structural walk above calls every method with a single placeholder
 * argument, so it never reaches the option-bearing arms.
 */
describe('CACHE_KEYS — query-string assembly (the branching methods)', () => {
    describe('calendar.range', () => {
        it('emits ONLY from/to when no options are supplied', () => {
            expect(CACHE_KEYS.calendar.range('2026-01-01', '2026-01-31')).toBe(
                '/calendar?from=2026-01-01&to=2026-01-31',
            );
        });

        it('emits ONLY from/to for an empty options object', () => {
            expect(
                CACHE_KEYS.calendar.range('2026-01-01', '2026-01-31', {}),
            ).toBe('/calendar?from=2026-01-01&to=2026-01-31');
        });

        it('omits an EMPTY types array — the unfiltered key stays byte-identical', () => {
            // A `types: []` that leaked `&types=` into the key would give the
            // "all types" view a different cache entry from the bare one, so
            // the two would never dedupe.
            expect(
                CACHE_KEYS.calendar.range('2026-01-01', '2026-01-31', {
                    types: [],
                    categories: [],
                }),
            ).toBe(CACHE_KEYS.calendar.range('2026-01-01', '2026-01-31'));
        });

        it('appends types, SORTED, so member order does not fork the cache', () => {
            const ab = CACHE_KEYS.calendar.range('2026-01-01', '2026-01-31', {
                types: ['task', 'audit'],
            });
            const ba = CACHE_KEYS.calendar.range('2026-01-01', '2026-01-31', {
                types: ['audit', 'task'],
            });

            expect(ab).toBe('/calendar?from=2026-01-01&to=2026-01-31&types=audit%2Ctask');
            expect(ba).toBe(ab);
        });

        it('appends categories independently of types', () => {
            expect(
                CACHE_KEYS.calendar.range('2026-01-01', '2026-01-31', {
                    categories: ['compliance'],
                }),
            ).toBe(
                '/calendar?from=2026-01-01&to=2026-01-31&categories=compliance',
            );
        });

        it('appends both, types before categories', () => {
            expect(
                CACHE_KEYS.calendar.range('2026-01-01', '2026-01-31', {
                    types: ['evidence'],
                    categories: ['b', 'a'],
                }),
            ).toBe(
                '/calendar?from=2026-01-01&to=2026-01-31&types=evidence&categories=a%2Cb',
            );
        });

        it('percent-encodes the from/to bounds', () => {
            expect(
                CACHE_KEYS.calendar.range(
                    '2026-01-01T00:00:00+01:00',
                    '2026-01-31T23:59:59+01:00',
                ),
            ).toBe(
                '/calendar?from=2026-01-01T00%3A00%3A00%2B01%3A00&to=2026-01-31T23%3A59%3A59%2B01%3A00',
            );
        });
    });

    describe('audits.nis2GapRemediations', () => {
        it('defaults to the lifecycle page HIGH floor', () => {
            // The default is part of the cache identity: the page fetches
            // `?minCriticality=HIGH`, so a bare-path default would make every
            // mutation target an entry nothing renders.
            expect(CACHE_KEYS.audits.nis2GapRemediations()).toBe(
                '/audits/nis2-gap/remediations?minCriticality=HIGH',
            );
        });

        it('carries an explicit floor', () => {
            expect(CACHE_KEYS.audits.nis2GapRemediations('MEDIUM')).toBe(
                '/audits/nis2-gap/remediations?minCriticality=MEDIUM',
            );
        });
    });

    // `dashboard.trends` is the third defaulted method; its default + explicit
    // arms are already pinned in the "dashboard home/executive/trends" case
    // above, so nothing is repeated here.
});

/**
 * The convention walk in the first `describe` block iterates
 * `Object.entries(CACHE_KEYS)` exactly TWO levels deep and skips any entry
 * whose value is not a function. `automation.rules` and
 * `automation.executions` are objects at that second level, so every method
 * beneath them is invisible to the walk AND to every pinned case above —
 * they are the only registry methods no test calls at all.
 *
 * That matters more than the depth accident suggests: the automation rule
 * pages read and mutate on these strings, and a near-miss key there does not
 * throw — the read 404s and the optimistic update lands on a cache entry
 * nothing renders. Pinned here so a renamed route has to change this file.
 */
describe('CACHE_KEYS — the third-level automation keys the walk cannot see', () => {
    it('automation.rules exposes list / detail / executions under /automation/rules', () => {
        expect(CACHE_KEYS.automation.rules.list()).toBe('/automation/rules');
        expect(CACHE_KEYS.automation.rules.detail('ar1')).toBe(
            '/automation/rules/ar1',
        );
        expect(CACHE_KEYS.automation.rules.executions('ar1')).toBe(
            '/automation/rules/ar1/executions',
        );
    });

    it('automation.executions.live is the live feed, NOT a rule-scoped path', () => {
        expect(CACHE_KEYS.automation.executions.live()).toBe(
            '/automation/executions/live',
        );
    });

    it('the second-level automation keys stay where they are', () => {
        expect(CACHE_KEYS.automation.templates()).toBe('/automation/templates');
        expect(CACHE_KEYS.automation.analytics()).toBe('/automation/analytics');
        // Deliberately NOT under /automation — the suggestions endpoint is an
        // AI route, and the registry follows the API path, not the screen.
        expect(CACHE_KEYS.automation.suggestions()).toBe(
            '/ai/automation-suggestions',
        );
    });
});

describe('CACHE_KEYS — composability with the hook layer', () => {
    /**
     * The registry is useful only if the strings it produces drop
     * straight into the Epic 69 hooks. The hooks in turn prefix
     * with `/api/t/{slug}`. Simulate that prefix here to assert the
     * round-trip — a registry method + the hook prefix should
     * produce the canonical absolute API URL.
     */
    function withTenant(slug: string, key: string): string {
        return `/api/t/${slug}${key}`;
    }

    it('controls.list() composes to /api/t/{slug}/controls', () => {
        expect(withTenant('acme', CACHE_KEYS.controls.list())).toBe(
            '/api/t/acme/controls',
        );
    });

    it('risks.detail(id) composes correctly', () => {
        expect(withTenant('acme', CACHE_KEYS.risks.detail('r1'))).toBe(
            '/api/t/acme/risks/r1',
        );
    });

    it('different tenants get different absolute URLs from the same key', () => {
        const key = CACHE_KEYS.controls.dashboard();
        expect(withTenant('acme', key)).not.toBe(
            withTenant('globex', key),
        );
    });
});
