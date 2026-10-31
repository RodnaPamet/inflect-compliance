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

import { budgetTrendLines } from '../helpers/bundle-budget-history';

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
 * worst route in each bucket from a real `next build --webpack`, plus ~4 KB.
 *
 * THAT IS ~0.6%, NOT "~5%". This header said ~5% from 46fa954b7 until
 * 2026-10-24, and the blocks below spent two separate raises complaining that
 * the real figure had become ~0.3% while this sentence still promised ~5% —
 * without either of them correcting the sentence. Measured across the five
 * buckets today it is 0.54% to 0.71%, which is what "measured + ~4 KB" means
 * on routes of 580-680 KB. The tightness is deliberate; the ~5% was not a
 * decision, it was a number nobody re-derived.
 *
 * WHERE THE LIVE FIGURE LIVES. Not in a comment. The suite derives the worst
 * route and remaining margin per bucket and prints them on the PASSING path,
 * so a reader of a green Build job sees how much room is left. The
 * hand-maintained `measured max` comments that used to sit beside each budget
 * are gone: they rotted four times (#4024), every time in the direction that
 * hid the margin, and nothing could fail while they were wrong.
 *
 * Tightening these towards the measured maxima, or shrinking the payload so
 * they can come down, is a separate and welcome diff. Raising one requires
 * saying in the PR what grew and why — and the headroom line in the Build log
 * is the evidence for that claim.
 */
const BUDGETS_KB: Record<string, number> = {
    /*
        RAISED BY THE NEXT 16.4.2 SECURITY BUMP (two unauthenticated RCEs), and
        the numbers are worth reading before the next raise.

        Measured on CI's own webpack build, main versus this branch — the only
        difference between them is the framework version:

              route                        main      16.4.2    delta
              controls/dashboard/page      603.7     606.0     +2.3
              risks/[riskId]/page          639.7     642.0     +2.3
              policies/[policyId]/page     667.9     671.0     +3.1

        So the framework cost 2-3 KB a route and three budgets were already
        spent: main sat 0.3 to 2.1 KB under them. The headroom this file's
        header describes as "~5%" had become ~0.3% without anything recording
        that, because the `measured max` comments then below had gone stale — the
        dashboard one read 574.4 KB against a main that measured 603.7. A
        comment that is supposed to carry the measurement is the only way a
        reader can see how much room is left, so they are corrected here too.

        The new budgets are measured + ~4 KB. Deliberately tight: enough to
        absorb a chunk-hash or zlib-version change, not enough for another
        framework bump to land silently. If the next one fails here too, that
        is the gate working, and the answer is to look at what these three
        routes ship rather than to keep adding 5.

        ─── RAISED AGAIN 2026-10-23 BY THE RADIX 1.3.x BUMP (#4011/#4020) ───

        The paragraph above asked the next person not to just add 5, so this
        raise owes an argument. It is an owner decision, taken with the
        attribution in hand rather than instead of it.

        #4020 carries ONLY the eleven Radix bumps, which makes its build a
        single-variable measurement:

              route                              before   after   delta
              controls/dashboard/page             606.0    611.6   +5.6
              risks/[riskId]/page                 642.0    649.4   +7.4
              controls/…/tests/[planId]/page      651.0    658.4   +7.4
              policies/[policyId]/page            671.0    677.6   +6.6

        That is about half of the 49-package production group's growth
        (#4006 measured 681.3 / 662.2 / 652.8 on three of these), so Radix is
        the larger single contributor and the rest is still unattributed.

        It is NOT an import-shape regression, which is the case the paragraph
        above is really warning about: the bump adds 108 packages and moves the
        internals wholesale (dismissable-layer, focus-scope, popper, a new
        use-layout-effect). There is no barrel to unpick and nothing to
        tree-shake back — it is genuinely more code, and the alternative is
        declining a maintained UI library's bumps indefinitely.

        The `measured max` comments were stale AGAIN, in the direction that
        hides headroom: `controls` read 613.1 KB for a route that measured
        651.0 in the table above it. All four were corrected in that PR. If they
        rot a third time the comment is not the right home for the number.
        They did rot a third time, and it isn't: #4041 deleted them and derives
        the headroom at run time instead.

        ─── `dashboard` RAISED 2026-10-25 BY ONE KB, FOR THE RETAINED FILTER OPTIONS (#4305) ───

        Measured on CI's webpack build, main (a docs-only PR the same hour)
        against this branch:

              route                              main     branch   delta
              controls/dashboard/page            615.8    616.1    +0.3
              risks/[riskId]/page                652.9    653.2    +0.3

        `risks` is not raised here: #4300 raised it to 654 the same evening
        for its own +0.3, which leaves room for this one.

        What grew: `useRetainedFilterOptions`, about 0.3 KB gzipped, which
        keeps a list filter's options from collapsing to the value just picked.
        Four list pages use it, and webpack places it in a chunk the tenant
        layout loads: every tenant route grew by 0.3-0.4 KB in the same build.
        Neither of these two routes uses it. Importing it by its own module
        path instead of the filter barrel was tried and measured the same.
        Main had 0.2 KB left in `dashboard`, so no change to shared client
        code could pass it. The raise is the measured delta rounded up, not
        measured + 4.

        ─── `dashboard` and `risks` RAISED 2026-10-26 BY THE PRODUCTION GROUP BUMP (#4342) ───

        Measured on CI's webpack build, main (cabd0adda) against #4342
        (2e05f56), whose only change is nine dependency versions:

              bucket          worst route                        main     #4342    delta
              dashboard       controls/dashboard/page            616.8    617.8    +1.0
              risks           risks/[riskId]/page                653.8    654.9    +1.1
              controls        controls/…/tests/[planId]/page     665.7    666.7    +1.0
              root            org/…/tenants/new/page             578.7    579.8    +1.1
              tenant-default  policies/[policyId]/page           675.2    676.3    +1.1

        What grew: of the nine packages, two reach the browser. `react-window`
        2.4.1 -> 2.5.0 (its ESM build is 7.6 -> 10.7 KB gzipped; it is behind
        `<DataTable>` and `<Combobox>`, so nearly every route loads it) and
        `motion` 13.4 -> 13.5 (about +0.8 KB). The other seven (AWS SDK,
        bullmq, dotenv, jose, nodemailer, stripe) are server-only. Every bucket
        grew by the same 1.0-1.1 KB, so this is shared code, not one route.

        Main had 0.2 KB left in both buckets, so the bump could not pass
        either. The new budgets are measured + ~4, the convention. `controls`
        and `root` are not raised: they still pass, with 1.3 and 0.2 KB left.
    */
    'dashboard': 622,
    // Raised 653 → 654 in the Tasks list fixes (#4300, #4278; owner decision).
    // Main measured this route at 652.9 KB (0.1 KB left); the PR measured
    // 653.2. The growth is in the task form and edit panel that the risk
    // page's Linked tasks panel loads, and the people picker: refusals now
    // show the server's reason, the reviewer picker asks for members who can
    // sign a task off, and staged links show labels instead of raw codes.
    // Raised 654 → 659 by the production group bump (#4342): 653.8 → 654.9
    // KB, from react-window 2.5 and motion 13.5. See the `dashboard` note.
    'risks': 659,
    // Raised 645 → 650 in the i18n-kept-primitives PR (#3004): that route had
    // grown to 643.8 KB on main (ff71f42ed), and localising the shared
    // primitives (useTranslations + key lookups in ~20 components, all on this
    // route) took it just past 645. The copy has to come from somewhere.
    // Raised 650 → 655 by projectZ #336 (primitives import each icon and hook
    // by its module, not through the barrels). Measured with two local
    // `next build --webpack` runs of the same tree, with and without that
    // change: 105 of 172 routes got smaller (/forgot-password, /reset-password
    // and /account/* by about 44 KB each), 64 got larger by at most 3.6 KB,
    // where webpack regrouped the shared chunks those modules land in. This
    // route was one of the 64, 647.4 → 651.0 KB.
    //
    // Raised 662 → 668 by #4200 (owner decision), and this one is NOT more
    // code. The route that tripped it, `controls/[controlId]/tests/[planId]`,
    // ships the SAME 445 modules on main and on that branch (module content
    // 481,753 vs 481,779 bytes — the 26 are one new cache key). Two local
    // `next build --webpack` runs of main (2d0260c) and the branch: 660.9 →
    // 665.4 KB. The difference is webpack re-partitioning those modules into
    // different chunks (58 → 59 for this route) because the branch changed
    // which modules the frameworks and onboarding pages share, and this gate
    // sums gzip PER CHUNK, so the same code compresses slightly worse when it
    // is split differently. 168 of 180 routes moved 2–5 KB in the same build.
    // main had 1.1 KB left in this bucket, so a repartition of that size was
    // going to trip it from any PR. 668 is measured + ~3, the convention.
    //
    // Raised 668 → 669 by the notifications bell fix (#4643, #4666), the
    // measured delta rounded up (the #4305 precedent), not measured + 4.
    // CI's webpack build, a PR changing no shared client code (#4667) against
    // this one: `controls/…/tests/[planId]/page` 667.9 → 668.1 KB, +0.2, and
    // every other bucket moved by the same 0.2. What grew is the bell, which
    // the top chrome mounts on every workspace page: it now chooses the open
    // workspace's list, stream and mark-read URLs, and links to the inbox.
    // Main had 0.1 KB left here, so no change to the chrome could pass it.
    //
    // Raised 669 -> 670 by the OpenShell gateway transport wiring (#4561), the
    // measured delta rounded up (the #4643 precedent), not measured + 4.
    //
    // CI's own webpack build, main (6f1f993d) against that branch:
    // `controls/.../tests/[planId]/page` 668.9 -> 669.0 KB. The whole route
    // table moved the same way -- 124 of 183 routes +0.1 KB, 59 unchanged -- so
    // this is shared code, not this route. Main had 0.0 KB left in this bucket,
    // so no shared byte at all could pass it.
    //
    // WHAT GREW IS `src/env.ts`, AND IT IS WORTH READING. #4561 adds four
    // server-only variables there (the gateway endpoint and three PEM paths).
    // Server vars are not meant to reach a browser, and their VALUES do not --
    // but `src/env.ts` is itself client-reachable (`notifications-bell.tsx` is
    // a `'use client'` component importing `@/env`; 95 importers in all), so
    // the module's whole ~800-line server SCHEMA is bundled on every workspace
    // page. That is why four optional strings cost 124 routes 0.1 KB each, and
    // why this bucket has now been raised four times in nine days
    // (655 -> 662 -> 668 -> 669 -> 670) by changes that added no route code.
    //
    // So this raise buys one PR's worth of room and does not fix the cause.
    // Splitting `env.ts` into server and client halves would, and it is a
    // 95-importer change that does not belong in a transport PR -- filed as
    // #4764, with this measurement, rather than done here or left unsaid.
    'controls': 670,
    // Catch-all for any other tenant page.
    'tenant-default': 682,
    // Auth / public / org pages.
    //
    // RAISED 575 -> 580 on 2026-10-23, and this entry is the cautionary one.
    // The block above corrected four `measured max` comments and left this
    // fifth, which was the most rotted of the lot: it read 545.3 KB for a route
    // that measured 574.1 on main the same day — a 29 KB drift, so the stated
    // headroom was 0.9 KB, about 0.16%, where the file header still described
    // ~5% AT THE TIME (#4041 has since removed these comments and corrected
    // that header to the measured figure, so read this block as history).
    // Nothing failed while that was true, which is precisely the failure
    // mode the block above describes; it simply had not reached this bucket yet.
    //
    // The remaining production-group bumps (#4023, 37 packages — tiptap,
    // sentry, lucide and the rest, with Radix already on main) add +2.3 KB
    // here, taking it to 576.4 and 1.4 KB past the old ceiling. Measured
    // single-variable: main 574.1 -> #4023 576.4.
    //
    // 580 is measured + ~4, the convention above. That is the THIRD rot of
    // these comments, which is the point at which a hand-maintained number
    // beside its own source stops being worth defending — filed separately.
    //
    // RAISED 580 -> 584 on 2026-10-29 (#4496), and the route that tripped it
    // is not in that PR. Main (e1d5b31bab) measured `org/…/tenants/new/page`
    // at 579.9 KB, 0.1 KB left; the Board findings branch measured it at
    // 580.1. That branch changes only the tenant dashboard, the Evidence
    // list and two shared dashboard-card modules, none of which the org page
    // imports. Every bucket moved by the same 0.1 KB in that build
    // (dashboard 618.1 -> 618.2, risks 655.1 -> 655.2, tenant-default
    // 680.3 -> 680.4), which is webpack re-partitioning shared chunks, the
    // effect the `controls` note describes, not code added to this route.
    // With 0.1 KB left, any change to client code could trip this bucket.
    // 584 is measured + ~4, the convention.
    'root': 584,
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
        const measured: Array<{ pageKey: string; sizeKb: number; budget: number }> = [];
        for (const [pageKey, files] of routes) {
            const sizeKb = gzippedKb(files);
            const budget = BUDGETS_KB[budgetKeyFor(pageKey)];
            measured.push({ pageKey, sizeKb, budget });
            if (sizeKb > budget) {
                violations.push(`${pageKey}: ${sizeKb.toFixed(0)}KB > ${budget}KB budget`);
            }
        }
        // Every route's figure, in the Build job's log. A budget that passes
        // says nothing about how close a route came, and a change that shrinks
        // a page (#3726) has nothing to be measured against without these.
        console.log(
            [
                `[bundle-size-budget] First Load JS, gzipped, ${measured.length} routes:`,
                ...measured
                    .sort((a, b) => b.sizeKb - a.sizeKb || (a.pageKey < b.pageKey ? -1 : 1))
                    .map((m) => `  ${m.sizeKb.toFixed(1).padStart(7)} KB / ${m.budget} KB  ${m.pageKey}`),
            ].join('\n'),
        );

        // HEADROOM, DERIVED — the thing the `measured max` comments used to
        // carry by hand and got wrong four times (#4024). Each drift hid how
        // little room was left: the `controls` comment read 613.1 KB for a
        // route measuring 651.0, and `root` read 545.3 for one measuring 574.1
        // against a 575 budget — 0.9 KB of real margin, with nothing anywhere
        // saying so, one bump before it failed.
        //
        // It is printed on the PASSING path deliberately. A green run is the
        // only moment this number is actionable and the only moment nobody
        // looks, which is exactly how a comment beside the budget goes stale
        // without anything failing.
        //
        // NOT a floor. The obvious next step is to fail below some margin, and
        // measured, that is wrong: this file's own "measured + ~4 KB"
        // convention IS 0.54-0.71% across the five buckets, so a 1% floor
        // would fail all five the day it landed.
        const worstPerBucket = new Map<string, (typeof measured)[number]>();
        for (const m of measured) {
            const bucket = budgetKeyFor(m.pageKey);
            const held = worstPerBucket.get(bucket);
            if (!held || m.sizeKb > held.sizeKb) worstPerBucket.set(bucket, m);
        }
        console.log(
            [
                '[bundle-size-budget] headroom by bucket (derived here, not from a comment):',
                ...[...worstPerBucket.entries()]
                    .sort((a, b) => a[0] < b[0] ? -1 : 1)
                    .map(([bucket, m]) => {
                        const left = m.budget - m.sizeKb;
                        const pct = (100 * left) / m.budget;
                        return (
                            `  ${bucket.padEnd(15)} ${m.sizeKb.toFixed(1).padStart(7)} KB` +
                            ` / ${String(m.budget).padStart(4)} KB` +
                            `  ${left.toFixed(1).padStart(6)} KB left (${pct.toFixed(2)}%)` +
                            `  ${m.pageKey}`
                        );
                    }),
                // THE TREND, so a fourth consecutive bump does not read as the
                // first (#4044). Derived from git, printed beside the headroom
                // rather than reconstructible only by reading three PRs.
                '[bundle-size-budget] budget history (from git, nothing stored):',
                ...budgetTrendLines(worstPerBucket.keys()),
            ].join('\n'),
        );
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
