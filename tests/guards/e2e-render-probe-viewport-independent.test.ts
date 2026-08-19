/**
 * An E2E "did the page render?" probe must not depend on the viewport.
 *
 * `loginAndGetTenant` retries a navigation until a chosen element is visible.
 * If that element is one the layout hides at some viewport, the probe can
 * NEVER succeed there — the loop exhausts its retries and performs redundant
 * full navigations on a page that already rendered correctly the first time.
 *
 * Not hypothetical. The probe was `aside`, which is `display:none` below `md`
 * by design — exactly what `responsive.spec.ts`'s
 * `sidebar hidden and hamburger visible` test asserts. Every mobile-viewport
 * test therefore did three wasted navigations, at roughly 2x the wall clock,
 * for as long as the helper existed (measured: ~10s -> ~4.5s per test).
 *
 * ═══ WHY THIS IS A SOURCE CHECK ═══
 *
 * Because no behavioural test can catch it. Reverting to `aside` leaves the
 * whole E2E suite GREEN — just slower. The bug is invisible as a failure and
 * shows up only as time, which is precisely why it survived. A structural
 * assertion is the only thing that fails when it comes back.
 *
 * It guards the invariant ("a render probe is viewport-independent"), not the
 * shape of one diff: any selector in the allowlist passes, and adding another
 * viewport-independent one is a one-line change with a written reason.
 *
 * ═══ WHY IT READS RAW SOURCE ═══
 *
 * An earlier version stripped comments first, and the stripper silently ate
 * the anchor: `e2e-utils.ts` contains the text `/*` INSIDE a `//` comment,
 * which a `/\*[\s\S]*?\*\/` regex happily treats as a block opener and then
 * swallows everything through the next close. Every assertion downstream then
 * passed while checking an empty string.
 *
 * So: no stripping. The patterns below are specific enough that prose cannot
 * satisfy them — they require an actual `locator('x').isVisible` call.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Selectors present at EVERY viewport the suite exercises (375x812 mobile
 * through 1280x720 desktop). `main` is the content landmark the tenant layout
 * renders at all widths.
 *
 * NOT allowed, and why: `aside` (desktop sidebar, `md:flex` — hidden on
 * mobile), `[data-testid="nav-toggle"]` (the hamburger — hidden on DESKTOP,
 * the mirror-image mistake).
 */
const VIEWPORT_INDEPENDENT = ['main', 'body'];

const src = fs.readFileSync(
    path.resolve(__dirname, '../e2e/e2e-utils.ts'),
    'utf8',
);

describe('E2E render probes are viewport-independent', () => {
    it('the retry loop is where this test thinks it is', () => {
        // Positive control. If the anchors move, the slice below goes empty
        // and every assertion on it would pass vacuously.
        expect(src).toMatch(/let renderRetries/);
        expect(src).toMatch(/export async function loginAndGetTenant/);
    });

    it('loginAndGetTenant probes a selector that exists at every viewport', () => {
        // Bounded to the retry loop by two anchors that occur once each.
        // A file-wide regex is NOT safe here: `gotoAndVerify` also probes,
        // via a `contentSelector` PARAMETER — correct there, and not a
        // literal this test can check — so a loose match finds the wrong one.
        const start = src.indexOf('let renderRetries');
        const end = src.indexOf('return slug;', start);
        expect(start).toBeGreaterThan(-1);
        // A reordered file yields a BACKWARDS slice, which is silently empty.
        expect(end).toBeGreaterThan(start);

        const loop = src.slice(start, end);
        const probe = loop.match(/locator\(\s*'([^']+)'\s*\)\s*\.isVisible/);
        expect(probe).not.toBeNull();
        expect(VIEWPORT_INDEPENDENT).toContain(probe![1]);
    });

    it('never probes `aside` — hidden below md', () => {
        expect(src).not.toMatch(/locator\(\s*'aside'\s*\)\s*\.isVisible/);
    });

    it('never probes the nav toggle either — hidden on desktop', () => {
        expect(src).not.toMatch(
            /locator\(\s*'\[data-testid="nav-toggle"\]'\s*\)\s*\.isVisible/,
        );
    });
});
