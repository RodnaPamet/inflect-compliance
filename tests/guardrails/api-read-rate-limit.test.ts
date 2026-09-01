/**
 * GAP-17 — Structural ratchet for the API read-rate-limit tier.
 *
 * The audit's GAP-17 finding was the absence of a dedicated read tier:
 * mutations had `API_MUTATION_LIMIT` (60/min) and auth had its own
 * Upstash-backed limiter, but tenant-scoped GETs were unprotected.
 * The fix landed on three coordinated surfaces:
 *
 *   1. Preset — `API_READ_LIMIT` in `src/lib/security/rate-limit.ts`
 *      (single source of truth for the numbers).
 *   2. Edge enforcement — `src/lib/rate-limit/apiReadRateLimit.ts`
 *      (Upstash + memory fallback, mirrors `authRateLimit.ts`).
 *   3. Middleware wire-up — `src/middleware.ts` calls the limiter
 *      after the JWT verify + tenant-access gate.
 *
 * A "simplify" PR could quietly remove the wire-up or the matcher
 * exclusions and re-introduce the unprotected state. This guardrail
 * asserts the structural shape of each surface — failing CI before
 * the change lands. Mirrors the GAP-13 + GAP-03 ratchet pattern.
 *
 * ONE claim here is not structural and cannot be: the fail-open posture
 * is a property of a RETURN VALUE, and the two regexes that used to
 * assert it were both satisfiable with the behaviour inverted (see the
 * block at the bottom of this file for the measurement). It is asserted
 * behaviourally instead, against a stubbed Upstash client that throws.
 *
 * Further functional behaviour is covered by:
 *   - `tests/unit/api-read-rate-limit.test.ts` (matcher + 429 + isolation)
 *   - `tests/unit/api-read-rate-limit-upstash.test.ts` (verdict mapping)
 */

import * as fs from 'fs';
import * as path from 'path';

import type { NextRequest } from 'next/server';

import {
    braceBlockAfter,
    codeOf,
    declarationOf,
    functionBodyOf,
} from '../helpers/source-blocks';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Every source read here is CODE — comments blanked, string literals kept.
 *
 * Not a per-assertion decision. Nearly every claim below is a positive
 * `toMatch` for an identifier or a path literal, and a positive match over
 * raw text is satisfied by ANY occurrence, a comment included. The three
 * files this reads are heavily commented and their comments name exactly the
 * things asserted: `apiReadRateLimit.ts` has a docblock listing
 * "health probes, /api/docs", and `src/middleware.ts` has one saying the
 * block "Sits AFTER the tenant-access gate … excluded by
 * `isApiReadRateLimited`". Delete `'/api/docs'` from EXCLUDED_PATHS and
 * leave a note behind — the obvious shape of that diff — and a raw-text
 * grep stays green while monitoring is throttled. String literals are kept
 * because the exclusion-list assertions ARE about literals. See #2238.
 */
function readRepoFile(rel: string): string {
    return codeOf(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
}

/**
 * The one deliberate exception. `docs/rate-limiting.md` is prose by
 * construction — the assertion there is that an operator can find the three
 * tiers described, so prose is the thing being checked, not a stand-in for
 * it. Reading it through `codeOf` would also be wrong mechanically: the
 * masker lexes TypeScript, and a markdown file's stray backticks and `//`
 * in URLs are not literals or comments.
 */
function readDoc(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

describe('GAP-17 ratchet — preset', () => {
    it('src/lib/security/rate-limit.ts exports API_READ_LIMIT with 60s window', () => {
        const src = readRepoFile('src/lib/security/rate-limit.ts');
        // Regression: removing or renaming the constant detaches the
        // enforcement module from the single source of truth and is
        // the kind of change a global "rename rate-limit constants"
        // PR could make without realising the impact.
        expect(src).toMatch(/export const API_READ_LIMIT/);
        // Window must be 60_000ms — anything longer (e.g. an hour
        // window with the same maxAttempts) silently weakens the gate.
        //
        // Bounded to the declaration's own top-level `;`. This was
        // `src.match(/export const API_READ_LIMIT[\s\S]+?\};/)` — a lazy
        // span to the first `};` ANYWHERE after the anchor, which is the
        // right answer only while the declaration happens to be the nearest
        // object literal. Wrap the preset in anything (a `satisfies`, a
        // helper call, a surrounding map of presets) and the span ends
        // early or late, silently, on a text that the assertions below can
        // still find their numbers in — from a NEIGHBOURING preset.
        const block = declarationOf(src, 'API_READ_LIMIT');
        expect(block).toMatch(/maxAttempts:\s*\d+/);
        expect(block).toMatch(/windowMs:\s*60\s*\*\s*1000|windowMs:\s*60000/);
    });

    it('the security/rate-limit-middleware barrel re-exports API_READ_LIMIT', () => {
        const src = readRepoFile('src/lib/security/rate-limit-middleware.ts');
        // Regression: a contributor importing from the security
        // barrel for consistency with other presets must find
        // API_READ_LIMIT there. Forgetting the re-export forces
        // callers to import from two different files for related
        // presets, which is the kind of drift that bites later.
        expect(src).toMatch(/API_READ_LIMIT/);
    });
});

describe('GAP-17 ratchet — edge-runtime enforcement module', () => {
    const ENFORCEMENT = 'src/lib/rate-limit/apiReadRateLimit.ts';

    it('exports the matcher predicate, slug extractor, and check function', () => {
        const src = readRepoFile(ENFORCEMENT);
        // These three symbols are the public contract the middleware
        // depends on. Renaming any of them is a breaking API change
        // for the wire-up, which is in a separate file and would
        // otherwise stop compiling silently if the wire-up is also
        // adjusted in the same diff.
        expect(src).toMatch(/export function isApiReadRateLimited/);
        expect(src).toMatch(/export function extractTenantSlug/);
        expect(src).toMatch(/export async function checkApiReadRateLimit/);
    });

    it('imports API_READ_LIMIT from the canonical preset module', () => {
        const src = readRepoFile(ENFORCEMENT);
        // Regression: inlining the limit numbers (e.g. `120` and
        // `60_000` as literals) in the enforcement module would
        // break the single-source-of-truth contract — a future
        // tweak to the preset would silently miss the enforcement
        // path. The import keeps the numbers in lock-step.
        // `[^}]*` rather than `[\s\S]*` on both sides: the greedy version
        // could span from one import's `{` to a LATER import's `}`, so
        // `import { X } from 'a'` … `import { API_READ_LIMIT } from 'b'` …
        // `import { Y } from '@/lib/security/rate-limit'` satisfied it with
        // the constant coming from the wrong module. A brace-free run
        // cannot leave the import statement it started in.
        expect(src).toMatch(
            /import\s*\{[^}]*\bAPI_READ_LIMIT\b[^}]*\}\s*from\s*['"]@\/lib\/security\/rate-limit['"]/,
        );
    });

    it('explicitly excludes the GAP-17 spec list (/api/health, /api/livez, /api/readyz, /api/docs)', () => {
        const src = readRepoFile(ENFORCEMENT);
        // GAP-17 named these paths as exclusions. A "tighten the
        // exclusion list" PR that drops any of them would re-introduce
        // a denial-of-monitoring vector (an attacker hammering the
        // API could starve out health probes, breaking deploys + ops
        // visibility).
        //
        // Bounded to the array that the matcher actually iterates, not
        // grepped over the module. A whole-file match is satisfied by the
        // path appearing in a log message, a comment, or a second list that
        // nothing reads — and the module's own docblock names these paths.
        const excluded = declarationOf(src, 'EXCLUDED_PATHS');
        expect(excluded).toMatch(/['"]\/api\/health['"]/);
        expect(excluded).toMatch(/['"]\/api\/livez['"]/);
        expect(excluded).toMatch(/['"]\/api\/readyz['"]/);
        expect(excluded).toMatch(/['"]\/api\/docs['"]/);
        // …and the matcher reads THAT array. Without this the block above
        // certifies a list, not an exclusion.
        //
        // Read this claim narrowly. `EXCLUDED_PATHS` is currently
        // UNREACHABLE: `isApiReadRateLimited` returns at the `/api/t/`
        // prefix gate first, and no string can both start with `/api/t/`
        // and equal-or-prefix `/api/health`, so the loop below it can never
        // be the reason for a `false`. The probes ARE protected — by the
        // gate, asserted in the next test — and the list is the declared
        // intent plus the thing that starts mattering the moment somebody
        // widens the matcher to `/api/`. So this asserts the list exists
        // and is wired, and deliberately does not claim it is what excludes
        // anything today. See tests/unit/api-read-rate-limit.test.ts, which
        // pins the disjointness as a property of the two path sets.
        expect(functionBodyOf(src, 'isApiReadRateLimited')).toMatch(
            /\bEXCLUDED_PATHS\b/,
        );
    });

    it('the matcher is GET-only and requires the /api/t/ prefix (not overbroad)', () => {
        const src = readRepoFile(ENFORCEMENT);
        // Regression: a refactor that drops the GET check would
        // double-throttle mutations (which already have
        // API_MUTATION_LIMIT). A refactor that widens the prefix
        // (e.g. `/api/`) would throttle admin / org / auth routes
        // unintentionally — those have their own policies.
        // Bounded to the function's own braces. This was
        // `src.match(/export function isApiReadRateLimited[\s\S]+?\n\}/)`
        // — a lazy span ending at the first `}` that happens to sit in
        // column zero, which is a property of the FORMATTER, not of the
        // function. Reformat, or nest the guard clauses one level deeper,
        // and the span ends somewhere else entirely.
        const block = functionBodyOf(src, 'isApiReadRateLimited');
        expect(block).toMatch(/method\s*!==\s*['"]GET['"]/);
        expect(block).toMatch(/['"]\/api\/t\/['"]/);
    });
});

describe('GAP-17 ratchet — middleware wire-up', () => {
    const MIDDLEWARE = 'src/middleware.ts';

    it('imports the matcher + slug extractor + check function from apiReadRateLimit', () => {
        const src = readRepoFile(MIDDLEWARE);
        // Regression: a contributor cleaning up "unused imports"
        // could remove the apiReadRateLimit imports if the wire-up
        // is also missed. The import line is the visible signal
        // that GAP-17 is wired here.
        expect(src).toMatch(/from\s+['"]@\/lib\/rate-limit\/apiReadRateLimit['"]/);
        expect(src).toMatch(/checkApiReadRateLimit/);
        expect(src).toMatch(/isApiReadRateLimited/);
        expect(src).toMatch(/extractTenantSlug/);
    });

    it('calls isApiReadRateLimited(method, pathname) before the rate-limit check', () => {
        const src = readRepoFile(MIDDLEWARE);
        // Regression: calling checkApiReadRateLimit unconditionally
        // would burn an Upstash round-trip (or a Map lookup) on
        // every request — including mutations and non-tenant routes.
        // The cheap predicate is the gate.
        expect(src).toMatch(/isApiReadRateLimited\s*\(/);
        // The check call must be inside the predicate's `if (...)` BODY —
        // not merely somewhere after it. This was
        // `/if\s*\(\s*isApiReadRateLimited[\s\S]+?checkApiReadRateLimit/`,
        // a lazy span that asserted only that the two identifiers appear in
        // that order in the file. Move the limiter call OUT of the `if` and
        // leave the (now empty) `if` behind — the shape of a refactor that
        // makes every request pay the limiter, including mutations and
        // non-tenant routes — and the span re-forms across the gap. Bound
        // to the block's own braces so it binds.
        const gap17Block = braceBlockAfter(
            src,
            'if\\s*\\(\\s*isApiReadRateLimited\\s*\\(',
        );
        expect(gap17Block).toMatch(/checkApiReadRateLimit\s*\(/);
        expect(gap17Block).toMatch(/extractTenantSlug\s*\(/);
    });

    it('the GAP-17 block sits AFTER the tenant-access gate (cheaper short-circuits run first)', () => {
        const src = readRepoFile(MIDDLEWARE);
        // The tenant-access gate (section 5) must run BEFORE the
        // rate-limit check (section 5c) so unauthorized cross-tenant
        // requests get a cheap 403, not a charged-budget 429. A
        // reorder that puts the rate-limit check first would let
        // attackers burn another tenant's budget by probing.
        const tenantGateIdx = src.indexOf('checkTenantAccess(');
        // The GAP-17 read-tier call is the one guarded by the
        // `isApiReadRateLimited(...)` predicate. A SEPARATE public-page tier
        // (the unauthenticated /trust/<slug> Trust Center) also calls
        // checkApiReadRateLimit earlier in the file — that's correct (it runs
        // before auth because the page is public). Anchor on the GAP-17
        // predicate so this assertion measures the GAP-17 block specifically.
        const gap17PredicateIdx = src.indexOf('isApiReadRateLimited(');
        const readRateIdx = src.indexOf('checkApiReadRateLimit(', gap17PredicateIdx);
        expect(tenantGateIdx).toBeGreaterThan(0);
        expect(gap17PredicateIdx).toBeGreaterThan(0);
        expect(readRateIdx).toBeGreaterThan(0);
        expect(readRateIdx).toBeGreaterThan(tenantGateIdx);
    });
});

// ─── Fail-open: asserted behaviourally, because a regex could not ──
//
// This block replaces two source regexes that could not fail (#2238):
//
//     expect(src).toMatch(/failing open/i);
//     expect(src).toMatch(/catch[\s\S]*?\{[\s\S]*?return\s*\{\s*ok:\s*true/);
//
// Both were vacuous, for two independent reasons. The first matched the
// LOG STRING, which survives any change to the return value. The second
// was a lazy `[\s\S]*?` span that began at the FIRST `catch` in the file
// — an unrelated Upstash-INIT block ~120 lines earlier — and ran to any
// later `return { ok: true }`, of which the happy path has one; it never
// bound the return to the catch it named. Flipping the catch to
// `{ ok: false, response: <503> }` — a Redis hiccup becoming a site-wide
// blackout on every /api/t/** read, the precise regression the test's own
// comment named — left this suite at 11/11 green.
//
// It is asserted here rather than only in tests/unit/api-read-rate-limit-
// upstash.test.ts because THIS is the file that claims the invariant. A
// claim that cannot fail is worse than no claim: it reads as coverage.

describe('GAP-17 — the read limiter FAILS OPEN on an Upstash outage', () => {
    const mockLogError = jest.fn<void, [string, Record<string, unknown>?]>();
    const mockLimit = jest.fn<Promise<never>, [string]>();

    /** Only `.headers.get()` is touched by the module under test. */
    function fakeReq(): NextRequest {
        return {
            headers: { get: (): string | null => null },
        } as unknown as NextRequest;
    }

    const SAVED = { ...process.env };

    beforeEach(() => {
        jest.clearAllMocks();
        mockLimit.mockRejectedValue(new Error('ECONNRESET'));
        // Set every gate EXPLICITLY rather than leaning on a default in
        // tests/mocks/env.ts — that mock reads process.env first, so an
        // assertion resting on its fallback silently depends on the var
        // being unset elsewhere.
        process.env.RATE_LIMIT_MODE = 'upstash';
        process.env.RATE_LIMIT_ENABLED = '1';
        process.env.AUTH_TEST_MODE = '0';
        process.env.NEXT_TEST_MODE = '0';
    });

    afterEach(() => {
        jest.dontMock('@upstash/redis');
        jest.dontMock('@upstash/ratelimit');
        jest.dontMock('@/lib/observability/edge-logger');
        process.env = { ...SAVED };
    });

    /**
     * Install an Upstash double whose `limit()` REJECTS, then load a fresh
     * copy of the module so its `_initialized` / `_limiter` state is clean.
     */
    async function loadWithUpstashThrowing(): Promise<
        typeof import('@/lib/rate-limit/apiReadRateLimit')
    > {
        jest.resetModules();
        jest.doMock('@upstash/redis', () => ({
            Redis: { fromEnv: (): { marker: string } => ({ marker: 'redis' }) },
        }));
        jest.doMock('@upstash/ratelimit', () => ({
            Ratelimit: Object.assign(
                function Ratelimit(this: unknown) {
                    return { limit: mockLimit };
                },
                { slidingWindow: (n: number, w: string) => ({ n, w }) },
            ),
        }));
        jest.doMock('@/lib/observability/edge-logger', () => ({
            edgeLogger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: mockLogError,
            },
        }));
        return import('@/lib/rate-limit/apiReadRateLimit');
    }

    it('ALLOWS the request — { ok: true } and no response to return', async () => {
        const mod = await loadWithUpstashThrowing();

        const result = await mod.checkApiReadRateLimit(fakeReq(), 'user-1', 'acme');

        // POSITIVE CONTROL, and it is load-bearing: `isBypassed()` also
        // returns `{ ok: true }`, so a bypass gate left on would make the
        // two assertions below pass without the catch ever running. Proving
        // Upstash was reached is what separates "failed open" from "never
        // enforced".
        expect(mockLimit).toHaveBeenCalledTimes(1);

        expect(result.ok).toBe(true);
        expect(result.response).toBeUndefined();
    });

    it('logs the degradation so an operator can see the limiter stopped enforcing', async () => {
        const mod = await loadWithUpstashThrowing();

        await mod.checkApiReadRateLimit(fakeReq(), 'user-1', 'acme');

        // The wording is asserted against a log the OUTAGE PATH actually
        // emitted, not against the file's source text.
        expect(mockLogError).toHaveBeenCalledWith(
            expect.stringMatching(/failing open/i),
            expect.objectContaining({ component: 'rate-limit', err: 'Error: ECONNRESET' }),
        );
    });

    it('keeps failing open for every request while the outage lasts', async () => {
        const mod = await loadWithUpstashThrowing();

        for (let i = 0; i < 5; i++) {
            const result = await mod.checkApiReadRateLimit(fakeReq(), 'user-1', 'acme');
            expect(result.ok).toBe(true);
        }
        // Not one request converted into a 429/503 along the way.
        expect(mockLimit).toHaveBeenCalledTimes(5);
        expect(mockLogError).toHaveBeenCalledTimes(5);
    });
});

describe('GAP-17 ratchet — operator-facing docs', () => {
    it('docs/rate-limiting.md exists and documents all three tiers', () => {
        const src = readDoc('docs/rate-limiting.md');
        // Regression: deleting the operator doc, or letting it drift
        // out of sync with the actual presets, leaves new contributors
        // and new SREs without a map of which routes are throttled
        // where. The structural test catches deletion; the doc itself
        // must stay accurate (manual review).
        expect(src).toMatch(/API_READ_LIMIT/);
        expect(src).toMatch(/API_MUTATION_LIMIT/);
        // Auth tier — covers the Upstash-backed authRateLimit module.
        expect(src).toMatch(/authRateLimit|\/api\/auth/);
        // Exclusion list must be visible.
        expect(src).toMatch(/\/api\/health/);
        expect(src).toMatch(/\/api\/docs/);
    });
});
