/**
 * The web-vitals denominator (#3547).
 *
 * Production had 12 `web_vital` beacons in 30 days and NOTHING TO DIVIDE THEM
 * BY. Measured 2026-10-15: every `route` value in a 500-line/30-day sample of
 * the production log belongs to a background job, because the app logs no HTTP
 * requests at all. So "12 beacons" could be read neither as "almost no
 * traffic" nor as "beacons are being dropped" — and those two have completely
 * different responses.
 *
 * MY FIRST ATTEMPT AT A DENOMINATOR WAS WORTHLESS, which is why this file
 * exists rather than a one-line log statement. Counting production lines
 * matching `"route":"/t/` returned 12, on exactly the same three days, in
 * exactly the same 2/8/2 split. The identity was the tell: `web_vital` lines
 * carry a `route` field of their own, so the probe had re-counted the
 * numerator. A probe that answers the same in both worlds is zero evidence.
 *
 * The decision and the label therefore live in a pure function, asserted here
 * on behaviour. The middleware that calls it can only be tested by grepping
 * its own source — and a spelling assertion against something that cannot fail
 * is how #3554 stayed green through seven days of production failure.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    DOCUMENT_LOAD_MSG,
    documentLoadRoute,
    normalizeVitalRoute,
    SOFT_NAVIGATION_MSG,
    softNavigationRoute,
} from '@/lib/observability/vital-route';
import { codeOf } from '../../helpers/source-blocks';

const doc = (pathname: string, over: Partial<Parameters<typeof documentLoadRoute>[0]> = {}) =>
    documentLoadRoute({ fetchDest: 'document', pathname, passedThrough: true, ...over });

/** An RSC fetch that accompanies a real client-side navigation. */
const soft = (pathname: string, over: Partial<Parameters<typeof softNavigationRoute>[0]> = {}) =>
    softNavigationRoute({
        rsc: '1',
        routerPrefetch: null,
        pathname,
        passedThrough: true,
        ...over,
    });

describe('documentLoadRoute — what counts as a page load', () => {
    it('counts a served top-level document', () => {
        expect(doc('/t/acme/dashboard')).toBe('/t/[tenant]/dashboard');
    });

    it('labels it with the SAME normaliser the beacons use', () => {
        // THE PROPERTY THE WHOLE DENOMINATOR DEPENDS ON. A denominator labelled
        // differently from the numerator cannot be divided by it, and the
        // failure is silent — two series that look comparable and are not.
        //
        // Derived from `normalizeVitalRoute` rather than written as a literal,
        // so a change to the normaliser cannot move one side only.
        const paths = [
            '/t/acme/dashboard',
            '/t/acme/controls/ckl1a2b3c4d5e6f7g8h9i0j1k',
            '/t/acme/risks/?x=1#h',
            '/',
            '/login',
        ];
        expect(paths.map((p) => doc(p))).toEqual(paths.map((p) => normalizeVitalRoute(p)));
    });

    it('does NOT count an RSC payload or a prefetch', () => {
        // The reason the header is the discriminator rather than the path. A
        // soft navigation fetches an RSC payload with `Sec-Fetch-Dest: empty`
        // and fires NO new vitals, because `useReportWebVitals` subscribes to
        // six per-DOCUMENT callbacks. Counting these would inflate the
        // denominator by the sidebar's prefetches — fourteen per page load on
        // the shape #3099 describes — and make the ratio read as mass beacon
        // loss.
        expect(doc('/t/acme/dashboard', { fetchDest: 'empty' })).toBeNull();
    });

    it('does NOT count a subresource', () => {
        expect(doc('/t/acme/logo.png', { fetchDest: 'image' })).toBeNull();
        expect(doc('/t/acme/app.css', { fetchDest: 'style' })).toBeNull();
        expect(doc('/t/acme/app.js', { fetchDest: 'script' })).toBeNull();
    });

    it('does NOT count a request that was redirected rather than served', () => {
        // A document request bounced to `/login` renders no app and emits no
        // vitals. Counting it would inflate the denominator with exactly the
        // requests that cannot contribute to the numerator — and an
        // unauthenticated crawler hitting a tenant URL would do that at
        // whatever rate it likes.
        expect(doc('/t/acme/dashboard', { passedThrough: false })).toBeNull();
    });

    it('does NOT count a document request to an API path', () => {
        // Defensive rather than observed: a non-page label in the series would
        // be divided into vitals that can never be reported for it.
        expect(doc('/api/telemetry/vitals')).toBeNull();
    });

    it('does NOT count a client that sends no Sec-Fetch-Dest, and that is DELIBERATE', () => {
        // THE KNOWN FLOOR, asserted so it is a decision rather than an
        // accident. Every browser able to run the web-vitals library sends the
        // header (Chrome 80+, Firefox 90+, Safari 16.4+), so the two
        // populations very nearly agree — but "very nearly" is not "exactly",
        // and the shape that would reveal a gap is a ratio ABOVE one
        // beacon-set per counted load. Counting header-less requests as
        // documents would be the opposite trade: every curl, probe and crawler
        // in the denominator.
        expect(doc('/t/acme/dashboard', { fetchDest: null })).toBeNull();
    });

    it('collapses ids and tenants, so the label cardinality stays finite', () => {
        // The denominator is a log series that will be grouped by route. An
        // un-collapsed label would make every row its own group and the
        // division impossible.
        expect(doc('/t/acme/controls/ckl1a2b3c4d5e6f7g8h9i0j1k')).toBe(
            '/t/[tenant]/controls/[id]',
        );
        expect(doc('/t/other/controls/ckl1a2b3c4d5e6f7g8h9i0j1k')).toBe(
            '/t/[tenant]/controls/[id]',
        );
    });
});

describe('softNavigationRoute — what counts as a client-side navigation (#4195)', () => {
    it('counts the RSC fetch that accompanies a navigation', () => {
        expect(soft('/t/acme/controls')).toBe('/t/[tenant]/controls');
    });

    it('labels it with the SAME normaliser the beacons use', () => {
        // The whole point of a denominator is that it is labelled identically
        // to the numerator; two spellings of a route cannot be divided.
        const pathname = '/t/acme/controls/clz9k3h2x0000abcdefghijkl';
        expect(soft(pathname)).toBe(normalizeVitalRoute(pathname));
    });

    it('does NOT count a prefetch, which may never be followed', () => {
        expect(soft('/t/acme/controls', { routerPrefetch: '1' })).toBeNull();
    });

    it('does NOT count a plain document request — that is the other counter', () => {
        // No `rsc` header at all. Were this counted, a document load would be
        // counted twice and the beacon ratio would read as dropped beacons.
        expect(soft('/t/acme/controls', { rsc: null })).toBeNull();
    });

    it('does NOT count a request that was redirected rather than served', () => {
        expect(soft('/t/acme/controls', { passedThrough: false })).toBeNull();
    });

    it('does NOT count an API path', () => {
        expect(soft('/api/health')).toBeNull();
    });

    it('reads the rsc header as PRESENT, not as a particular value', () => {
        // Next sends `rsc: 1` today. Pinning the value would make a future
        // `rsc: 2` read as "no navigation happened", which is the silent
        // direction — the denominator would shrink and dropped beacons would
        // look like a quiet app.
        expect(soft('/t/acme/controls', { rsc: '2' })).toBe('/t/[tenant]/controls');
        expect(soft('/t/acme/controls', { rsc: '' })).toBe('/t/[tenant]/controls');
    });

    it('is a DIFFERENT message from the document counter', () => {
        // Merging them would make every existing query of `document_load`
        // silently mean something else.
        expect(SOFT_NAVIGATION_MSG).not.toBe(DOCUMENT_LOAD_MSG);
    });
});

describe('the denominator tracks what the client actually subscribes to (#4195)', () => {
    /**
     * THE ASSERTION THE ORIGINAL 15 COULD NOT MAKE.
     *
     * Every one of them asks "what counts as a document load", and every one is
     * still correct. None asks whether document loads are the RIGHT
     * denominator — so when `useReportWebVitals` started reporting soft
     * navigations, the instrument stayed accurate and became aimed one level
     * off, and no amount of reading the suite revealed it.
     *
     * This reads the INSTALLED Next client. It is the only thing in either file
     * that can notice the premise moving again: if a future version drops
     * `reportSoftNavs`, or extends it to TTFB, the denominator needs revisiting
     * and this says so.
     */
    const nextClient = (() => {
        for (const rel of [
            '../../../node_modules/next/dist/client/web-vitals.js',
            '../../../node_modules/next/dist/esm/client/web-vitals.js',
        ]) {
            const abs = path.resolve(__dirname, rel);
            if (fs.existsSync(abs)) return fs.readFileSync(abs, 'utf-8');
        }
        return '';
    })();

    it('reads a real copy of the installed web-vitals client', () => {
        // The denominator for the assertions below. An empty read would make
        // the soft-nav count zero and pass the "then we need a counter" arm
        // vacuously.
        expect(nextClient.length).toBeGreaterThan(200);
        expect(nextClient).toContain('onTTFB');
    });

    it('still reports soft navigations, which is WHY a second denominator exists', () => {
        const softNavSubscriptions = nextClient.match(/reportSoftNavs/g)?.length ?? 0;

        // Four today — CLS, LCP, INP, FCP — and TTFB alone without it.
        // Asserted as a RANGE rather than exactly 4: the fix is required by
        // there being ANY, and pinning the count would redden on a change that
        // does not alter what this module must do.
        expect(softNavSubscriptions).toBeGreaterThan(0);

        // So the soft-navigation counter must exist. If this ever drops to
        // zero, THIS is the test that should fail, and the right response is to
        // revisit the two denominators rather than to delete the assertion.
        expect(typeof softNavigationRoute).toBe('function');
        expect(SOFT_NAVIGATION_MSG).toBeTruthy();
    });
});

describe('the denominator is actually emitted (#3547)', () => {
    // STRUCTURAL, AND KEPT AS SMALL AS POSSIBLE. `src/middleware.ts` cannot be
    // imported here — it pulls the whole Edge auth path — so this is a source
    // read, which is a weak instrument: it asserts a spelling, not a
    // behaviour. Everything that CAN be decided behaviourally is in the
    // describe above. What is left is the one thing a unit test cannot reach:
    // whether the pure function is called at all.
    //
    // Without this, `documentLoadRoute` could be perfect and never invoked —
    // code-complete and delivering nothing.
    // MASKED, and this file earned the rule twice in one session.
    // `raw-source-assertion-ratchet` holds that an assertion over unmasked
    // source can be satisfied by a COMMENT, so "delete the code, keep the note
    // explaining it" is a green diff. That is not hypothetical here: the
    // middleware block this reads carries a long comment of mine that NAMES
    // `documentLoadRoute` and `normalizeVitalRoute` in prose, one character
    // from the needles below.
    //
    // `codeOf` blanks comments, keeps string literals — so
    // `'sec-fetch-dest'` is still matchable — and preserves offsets.
    const source = codeOf(
        fs.readFileSync(path.resolve(__dirname, '../../../src/middleware.ts'), 'utf-8'),
    );

    it('reads a real copy of the middleware', () => {
        // The denominator for the needles below; an empty read would satisfy
        // none of them, but a wrong path would throw rather than pass.
        expect(source.length).toBeGreaterThan(1000);
    });

    it('is reading CODE, not my own comment about the code', () => {
        // The mask, proved rather than trusted — this is the assertion that
        // makes the needles below mean something. The phrase is from the
        // middleware comment block and appears nowhere in its code.
        expect(source).not.toContain('nothing to divide');
        expect(source).toContain('documentLoadRoute({');
    });

    it('calls documentLoadRoute and logs its result', () => {
        expect(source).toContain('documentLoadRoute({');
        expect(source).toContain('edgeLogger.info(DOCUMENT_LOAD_MSG');
    });

    it('passes the pass-through term, not a constant', () => {
        // The failure this prevents is specific: `passedThrough: true` would
        // compile, pass every behavioural test above, and silently count
        // redirects to `/login`.
        //
        // BOUND TO THE CALL, not a bare needle. `passedThrough: isPassThrough`
        // appeared once when this was written and appears twice since #4195
        // added the soft-navigation counter — so the bare needle had become
        // satisfiable by the OTHER call site, and the document counter's own
        // term could have been replaced by a literal with this still green.
        // `assertion-needle-uniqueness-ratchet` caught it on a diff that
        // changed nothing in this assertion, which is the case its header says
        // it exists for.
        //
        // `[^}]*` rather than `.*`: it cannot cross out of the object literal,
        // so it is not an interior span of the kind
        // `assertion-span-reach-ratchet` counts.
        expect(source).toMatch(/documentLoadRoute\(\{[^}]*passedThrough:\s*isPassThrough/);
    });

    it('reads the dest header from the request rather than inventing it', () => {
        expect(source).toContain("fetchDest: req.headers.get('sec-fetch-dest')");
    });

    it('logs the route and nothing identifying', () => {
        // One field. A tenant slug, user id or IP here would turn an access
        // log into a PII store, and the route label is already collapsed to
        // fixed cardinality.
        expect(source).toContain('{ route: documentRoute }');
    });

    it('calls softNavigationRoute and logs its result too (#4195)', () => {
        // The same "wired is not delivered" check the document counter gets.
        // `softNavigationRoute` could be perfect and never invoked, and the
        // beacon ratio would stay 50:1 with a correct unused function beside it.
        expect(source).toContain('softNavigationRoute({');
        expect(source).toContain('edgeLogger.info(SOFT_NAVIGATION_MSG');
    });

    it('reads BOTH router headers off the request, not one of them', () => {
        // Each header carries half the decision, and dropping either fails
        // silently in a different direction: without `rsc` nothing is counted,
        // and without `next-router-prefetch` every hovered link is.
        expect(source).toContain("req.headers.get('rsc')");
        expect(source).toContain("req.headers.get('next-router-prefetch')");
    });

    it('passes the pass-through term to the soft counter as well', () => {
        // A redirect renders no app and fires no vitals either way, so the
        // second counter needs the same term — and a `true` literal here would
        // count every redirected RSC fetch.
        expect(source).not.toMatch(/softNavigationRoute\(\{[^}]*passedThrough:\s*true/);
        expect(source).toMatch(/softNavigationRoute\(\{[^}]*passedThrough:\s*isPassThrough/);
    });

    it('names the message with the shared constant, not a literal', () => {
        // The numerator and denominator are matched by message name in any
        // query that divides them. A literal here and a constant there is how
        // the two come to disagree after a rename.
        expect(DOCUMENT_LOAD_MSG).toBe('document_load');
        expect(source).not.toContain("edgeLogger.info('document_load'");
    });
});
