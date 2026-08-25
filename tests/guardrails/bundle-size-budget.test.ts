/**
 * Bundle-size budget gate (First Load JS per app route).
 *
 * Fails if a tracked route's client JS payload exceeds its budget. The budgets
 * are an ALLOWLIST: a PR that legitimately grows a route past its budget
 * updates the number in the same diff (mirrors the `as any` ratchet shape).
 *
 * ── THE CONTRACT (read this before changing the skip branch) ────────────
 *
 * This suite has three outcomes, and which one it takes is decided by ONE
 * environment variable:
 *
 *     BUNDLE_BUDGET_REQUIRE_MANIFEST
 *
 * | production build output | REQUIRE_MANIFEST | outcome                     |
 * | ----------------------- | ---------------- | --------------------------- |
 * | present                 | either           | budgets MEASURED + enforced |
 * | absent                  | unset / falsy    | SKIP (no build in this tree)|
 * | absent                  | 1 / true / yes   | HARD FAIL, loudly           |
 *
 * The variable means exactly one thing: "a production `next build` ran in this
 * job before this suite was invoked". It is a PROMISE MADE BY THE CALLER. Set
 * it ONLY in a job that has already built — today ci.yml `Build` (every PR)
 * and bundle-analyze.yml `Analyze client/server bundles` (main + label). Both
 * wirings are asserted by tests/guardrails/bundle-budget-runs-after-build.test.ts,
 * so deleting the CI step turns this gate red rather than silently returning it
 * to the always-skip state described below.
 *
 * A `next dev` tree is explicitly NOT a build: `next dev` writes `.next/dev`
 * and `.next/node_modules`, which `next build` never does. Without that check a
 * developer with a dev server running would start measuring half-compiled
 * routes against production budgets, and `npm test` would go red for reasons
 * having nothing to do with their diff — the one outcome that gets a gate
 * deleted rather than fixed.
 *
 * ── WHY FAIL-CLOSED AT ALL ──────────────────────────────────────────────
 *
 * Until 2026-08-25 this file ran in the `Ratchets` job on every PR, where no
 * build exists, so it took the skip branch and reported a green pass. It had
 * therefore never been ABLE to fail on a pull request — a check that cannot
 * fail is worse than no check, because it occupies the slot a real one would
 * have. It was worse than that: the source it read, `.next/app-build-manifest.json`,
 * was REMOVED from Next in v16 (`grep -r app-build-manifest node_modules/next`
 * returns nothing on 16.3.1), so it had been skipping in `Bundle Analyze` too —
 * the one job that builds. Every route budget in this file had been dead since
 * the Next 16 upgrade and nothing said so, because "no manifest" was spelled
 * "pass".
 *
 * ── WHERE THE NUMBERS COME FROM NOW ─────────────────────────────────────
 *
 * Next 16 emits per-route First Load JS in `.next/diagnostics/route-bundle-stats.json`
 * — but `writeRouteBundleStats` is called ONLY under Turbopack
 * (next/dist/build/index.js), and this repo builds with `next build --webpack`
 * (nonce strict-CSP chunks). So that file does not exist here either, and the
 * webpack build prints no First Load JS column at all.
 *
 * What a webpack build DOES emit is one client-reference manifest per app
 * route, `.next/server/app/<route>/page_client-reference-manifest.js`, whose
 * `clientModules[*].chunks` carry the `static/chunks/*.js` a route ships. First
 * Load JS is the union of those with the shared entry files from
 * `.next/build-manifest.json` (`rootMainFiles` + `polyfillFiles`) — the same
 * shape Next's own `collectAppRouterStats` computes. Those files are read the
 * way Next reads them (evaluate, then read `__RSC_MANIFEST`) rather than
 * regex-scraped, so a format change cannot silently under-count.
 *
 * Sizes are GZIPPED KB, which is what the budgets have always been in.
 *
 * ── VACUITY ─────────────────────────────────────────────────────────────
 *
 * The other way this gate passes without checking anything is measuring
 * nothing: a moved directory, a renamed manifest, or a `.next` artifact
 * unpacked without `static/` all yield "0 KB, no violations". The second test
 * is the positive companion — it fails unless real routes were found, their
 * chunks are on disk, and the heaviest route measured strictly above the
 * shared baseline (i.e. per-route chunks were actually attributed).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as zlib from 'node:zlib';

const ROOT = path.resolve(__dirname, '../..');
const NEXT_DIR = path.join(ROOT, '.next');
const BUILD_MANIFEST = path.join(NEXT_DIR, 'build-manifest.json');
const APP_SERVER_DIR = path.join(NEXT_DIR, 'server', 'app');
const CRM_SUFFIX = '_client-reference-manifest.js';

/**
 * Written by `next dev`, never by `next build`. Presence means this `.next` is
 * a dev tree and carries no production budget signal.
 */
const DEV_TREE_MARKERS = ['dev', 'node_modules'] as const;

/**
 * The caller's promise that a production build ran in this job. See the
 * contract table above — this is the ONLY input that turns an absent build
 * from a skip into a failure.
 */
const REQUIRE_MANIFEST_ENV = 'BUNDLE_BUDGET_REQUIRE_MANIFEST';
const requireManifest = /^(1|true|yes|on)$/i.test(process.env[REQUIRE_MANIFEST_ENV] ?? '');

/** Share of route-referenced chunks that must exist on disk. */
const MIN_CHUNK_PRESENCE = 0.95;

/**
 * Per-route First Load JS budgets, gzipped KB. Allowlist — update in-diff.
 *
 * MEASURED, not aspirational. The previous values (150-400) were the file's
 * own admitted "starting targets, not measured ceilings" and had never once
 * been evaluated — see the dead-source note above. The numbers below are the
 * worst route in each bucket from a real `next build --webpack` on
 * 46fa954b7, plus ~5% headroom (enough to absorb a chunk-hash or zlib-version
 * wobble, tight enough that a genuine regression trips).
 *
 * Tightening these towards the measured maxima, or shrinking the payload so
 * they can come down, is a separate and welcome diff. Raising one requires
 * saying in the PR what grew and why.
 */
const BUDGETS_KB: Record<string, number> = {
    // measured max 574.4 KB — /t/[tenantSlug]/(app)/controls/dashboard/page (8 routes)
    'dashboard': 605,
    // measured max 605.8 KB — /t/[tenantSlug]/(app)/risks/[riskId]/page (16 routes)
    'risks': 640,
    // measured max 613.1 KB — /t/[tenantSlug]/(app)/controls/[controlId]/tests/[planId]/page (7 routes)
    'controls': 645,
    // Catch-all for any other tenant page.
    // measured max 637.5 KB — /t/[tenantSlug]/(app)/policies/[policyId]/page (96 routes)
    'tenant-default': 670,
    // Auth / public / org pages.
    // measured max 545.3 KB — /org/[orgSlug]/(app)/tenants/new/page (23 routes)
    'root': 575,
};

/** Map an app route key to a budget key. */
function budgetKeyFor(pageKey: string): string {
    if (pageKey.includes('/dashboard/')) return 'dashboard';
    if (pageKey.includes('/risks/') && pageKey.endsWith('/page')) return 'risks';
    if (pageKey.includes('/controls/') && pageKey.endsWith('/page')) return 'controls';
    if (pageKey.includes('/t/[tenantSlug]')) return 'tenant-default';
    return 'root';
}

/** A `next dev` tree is not a build. */
function isDevTree(): boolean {
    return DEV_TREE_MARKERS.some((m) => fs.existsSync(path.join(NEXT_DIR, m)));
}

function productionBuildPresent(): boolean {
    return !isDevTree() && fs.existsSync(BUILD_MANIFEST) && fs.existsSync(APP_SERVER_DIR);
}

function findClientReferenceManifests(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) findClientReferenceManifests(abs, out);
        else if (entry.name.endsWith(CRM_SUFFIX)) out.push(abs);
    }
    return out;
}

interface ClientModule {
    chunks?: unknown[];
}
interface RscManifestEntry {
    clientModules?: Record<string, ClientModule>;
}

/**
 * Evaluate one client-reference manifest and return its route → chunk-set map.
 *
 * These files are `globalThis.__RSC_MANIFEST[<route>] = {...}` assignments;
 * Next reads them by `require()` + reading the global. A throwaway vm context
 * does the same without leaking into this process or through jest's
 * transformer.
 */
function readRouteChunks(file: string): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    const ctx = vm.createContext({});
    try {
        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { timeout: 5_000 });
    } catch {
        return result;
    }
    const manifest = (ctx as { __RSC_MANIFEST?: Record<string, RscManifestEntry> }).__RSC_MANIFEST;
    for (const [route, entry] of Object.entries(manifest ?? {})) {
        const chunks = new Set<string>();
        for (const mod of Object.values(entry?.clientModules ?? {})) {
            for (const chunk of mod?.chunks ?? []) {
                if (typeof chunk === 'string' && chunk.endsWith('.js')) chunks.add(chunk);
            }
        }
        result.set(route, chunks);
    }
    return result;
}

// The same framework/shared chunks are referenced by every route, so the naive
// implementation gzips the big ones hundreds of times. Memoised per file.
const gzipCache = new Map<string, number | null>();

/**
 * Gzipped byte length of one chunk, or null when it is not on disk.
 *
 * Chunk paths in the manifest are URL paths — Next serves them under
 * `/_next/`, so a dynamic segment appears percent-encoded
 * (`app/invite/%5Btoken%5D/page-….js`) while the file on disk is
 * `app/invite/[token]/page-….js`. Reading the raw string finds 37% of this
 * app's chunks and silently scores the rest as zero; the vacuity companion
 * below is what caught that.
 */
function gzippedBytes(rel: string): number | null {
    const cached = gzipCache.get(rel);
    if (cached !== undefined) return cached;
    let decoded = rel;
    try {
        decoded = decodeURIComponent(rel);
    } catch {
        /* malformed escape — fall back to the raw path */
    }
    let result: number | null = null;
    for (const candidate of new Set([decoded, rel])) {
        const abs = path.join(NEXT_DIR, candidate);
        if (!fs.existsSync(abs)) continue;
        try {
            result = zlib.gzipSync(fs.readFileSync(abs)).length;
            break;
        } catch {
            /* unreadable chunk — treat as absent */
        }
    }
    gzipCache.set(rel, result);
    return result;
}

function gzippedKb(files: Iterable<string>): number {
    let total = 0;
    for (const rel of files) total += gzippedBytes(rel) ?? 0;
    return total / 1024;
}

describe('bundle-size budget', () => {
    const buildPresent = productionBuildPresent();

    if (!buildPresent && requireManifest) {
        // FAIL CLOSED. Something upstream said it built; the output it promised
        // is not here. Either the build did not run, it failed without failing
        // the job, it wrote somewhere else (NEXT_TEST_MODE routes output to
        // `.next-test/`), or Next moved the files again — as it did in v16,
        // silently disabling this gate for months.
        it(`fails closed — ${REQUIRE_MANIFEST_ENV} is set but there is no production build to measure`, () => {
            throw new Error(
                [
                    `${REQUIRE_MANIFEST_ENV}=${process.env[REQUIRE_MANIFEST_ENV]} promises a production build ran`,
                    'in this job, but no build output was found under .next/:',
                    `  build-manifest.json      ${fs.existsSync(BUILD_MANIFEST) ? 'present' : 'MISSING'}`,
                    `  server/app/              ${fs.existsSync(APP_SERVER_DIR) ? 'present' : 'MISSING'}`,
                    `  dev-tree markers         ${isDevTree() ? 'PRESENT (this is a `next dev` tree, not a build)' : 'absent'}`,
                    '',
                    'The per-route First Load JS budgets were NOT checked. Do not silence this by',
                    `unsetting ${REQUIRE_MANIFEST_ENV} — that returns the gate to the always-skip state it`,
                    'sat in until 2026-08-25, where it passed on every PR without ever measuring anything.',
                    '',
                    'Likely causes, in the order they actually happen:',
                    '  1. `next build` did not run in this job before this suite (check step order).',
                    '  2. The build wrote elsewhere — NEXT_TEST_MODE sends output to `.next-test/`.',
                    '  3. A `.next` artifact was downloaded without server/app or static/.',
                    '  4. Next moved the client-reference manifests again. If the repo has switched to',
                    '     Turbopack, .next/diagnostics/route-bundle-stats.json is the supported source',
                    '     and this suite should read that instead.',
                ].join('\n'),
            );
        });
        return;
    }

    if (!buildPresent) {
        it('skipped — no production build output (run via the Build or Bundle Analyze workflow)', () => {
            // eslint-disable-next-line no-console
            console.log('[bundle-size-budget] no production .next build present — skipping (no build in this job).');
            expect(true).toBe(true);
        });
        return;
    }

    const buildManifest = JSON.parse(fs.readFileSync(BUILD_MANIFEST, 'utf8')) as {
        rootMainFiles?: string[];
        polyfillFiles?: string[];
    };
    const sharedFiles = [...(buildManifest.rootMainFiles ?? []), ...(buildManifest.polyfillFiles ?? [])].filter((f) =>
        f.endsWith('.js'),
    );

    /** route key → first-load chunk set (route chunks ∪ shared entry files). */
    const routes = new Map<string, Set<string>>();
    for (const file of findClientReferenceManifests(APP_SERVER_DIR)) {
        for (const [route, chunks] of readRouteChunks(file)) {
            // Only `/page` entries are navigable app routes with a client
            // payload. `/route` (route handlers) and `/layout` entries carry no
            // First Load JS of their own, and counting them would report the
            // shared baseline hundreds of times as if it were a page.
            if (!route.endsWith('/page')) continue;
            routes.set(route, new Set([...sharedFiles, ...chunks]));
        }
    }

    it('every tracked route is within its First Load JS budget', () => {
        const violations: string[] = [];
        for (const [pageKey, files] of routes) {
            const sizeKb = gzippedKb(files);
            const budget = BUDGETS_KB[budgetKeyFor(pageKey)];
            if (sizeKb > budget) {
                violations.push(`${pageKey}: ${sizeKb.toFixed(0)}KB > ${budget}KB budget`);
            }
        }
        expect(violations).toEqual([]);
    });

    // The positive companion. Without it, "no violations" is satisfied just as
    // well by "nothing was measured" — and that is the state a moved directory,
    // a renamed manifest, or a stripped artifact produces.
    it('actually measured the routes it certified', () => {
        expect(routes.size).toBeGreaterThan(0);

        const referenced = new Set<string>();
        for (const files of routes.values()) for (const f of files) referenced.add(f);
        expect(referenced.size).toBeGreaterThan(0);

        const missing = [...referenced].filter((rel) => gzippedBytes(rel) === null);
        const presence = 1 - missing.length / referenced.size;
        if (presence < MIN_CHUNK_PRESENCE) {
            throw new Error(
                `only ${(presence * 100).toFixed(1)}% of ${referenced.size} referenced chunks are on disk ` +
                    `(${missing.length} missing, e.g. ${missing.slice(0, 5).join(', ')}). Every budget above was ` +
                    'measured against a partial tree, so "no violations" certifies nothing.',
            );
        }

        // Strictly above the shared baseline proves per-route chunks were
        // actually attributed — not that every route collapsed to the floor.
        const sharedKb = gzippedKb(sharedFiles);
        const largestKb = Math.max(...[...routes.values()].map(gzippedKb));
        expect(sharedKb).toBeGreaterThan(0);
        expect(largestKb).toBeGreaterThan(sharedKb);
    });
});
