/**
 * Route normalisation for client telemetry, and the document-load denominator.
 *
 * ─── WHY THIS MODULE EXISTS SEPARATELY ────────────────────────────────────
 *
 * `normalizeVitalRoute` lived in `web-vitals.ts`, which imports
 * `@opentelemetry/api` and the Node pino logger. The Edge middleware needs the
 * same normalisation and can import neither. Duplicating the function was the
 * alternative and is the worse one: the whole point of the denominator is that
 * it is labelled IDENTICALLY to the numerator, and two copies of a regex are
 * two things that drift. `web-vitals.ts` re-exports it, so nothing that
 * imported it from there had to change.
 *
 * ─── THE DENOMINATOR (#3547) ──────────────────────────────────────────────
 *
 * Production had 12 `web_vital` beacons in 30 days and NOTHING TO DIVIDE THEM
 * BY. Measured 2026-10-15: every `route` value in a 500-line/30-day sample of
 * the production log is a background job (`job:control-test-scheduler` and
 * friends) — the app logs no HTTP requests at all. So "12 beacons" could not
 * be read as "almost no traffic" or "beacons are being dropped", and those two
 * have completely different responses.
 *
 * My first attempt at a denominator counted lines matching `"route":"/t/`, got
 * 12 on exactly the same three days in exactly the same 2/8/2 split, and that
 * identity was the tell: `web_vital` lines carry a `route` field of their own,
 * so the probe had re-counted the numerator. A probe that returns the same
 * answer in both worlds is zero evidence.
 *
 * ─── TWO DENOMINATORS, BECAUSE THERE ARE TWO QUESTIONS (#4195) ────────────
 *
 * This module shipped with ONE, on a premise that has since gone false:
 *
 *   > A browser's web-vitals fire ONCE PER DOCUMENT LOAD, not per client-side
 *   > navigation.
 *
 * That was true of `useReportWebVitals` when it was written. It is not true of
 * four of the five metrics now. Next 16.4.2 subscribes
 * `onCLS`/`onLCP`/`onINP`/`onFCP` with `{ reportSoftNavs: true }` and only
 * `onTTFB` without, and web-vitals 6.x honours it. Measured against 30 days of
 * production beacons: 2409 `soft-navigation` against 39 `navigate` and 11
 * `back-forward` — 98% of beacons are client-side navigations. So the one
 * denominator counted document loads while the numerator was dominated by
 * something else, at roughly 50 beacon-sets per counted load. The old docblock
 * even named that as the failure signal: "a ratio above 1 beacon-set per
 * counted load is the shape that would reveal it".
 *
 * The reasoning was not wrong; a dependency changed underneath it. What was
 * missing is that one ratio was answering two questions that have now come
 * apart:
 *
 *   1. ARE BEACONS BEING DROPPED?  The numerator is per beacon-set, so the
 *      denominator must be too: document loads PLUS soft navigations.
 *   2. IS ANYONE USING THE APP?    Document loads, still, and unchanged — a
 *      soft navigation is not a visit.
 *
 * Both are emitted, each from its own pure function below, so neither answer
 * has to be reconstructed from the other.
 *
 * ─── WHAT COUNTS AS A DOCUMENT LOAD ───────────────────────────────────────
 *
 * The discriminator is `Sec-Fetch-Dest: document`: an RSC payload or a
 * prefetch arrives as `empty`, an image as `image`.
 *
 * ─── WHAT COUNTS AS A SOFT NAVIGATION, AND WHY NOT `Sec-Fetch-Dest` ───────
 *
 * A client-side navigation is invisible to the server except for the RSC fetch
 * that accompanies it, so that fetch is the proxy. The discriminator is Next's
 * OWN header, `rsc` (`RSC_HEADER` in
 * `next/dist/client/components/app-router-headers`), and NOT
 * `Sec-Fetch-Dest: empty`:
 *
 *   · `empty` is what every `fetch()` sends, including the beacon POST this
 *     denominator is for — which would make the instrument count itself, the
 *     same self-reference that made the first attempt at a denominator return
 *     the numerator.
 *   · `rsc` says what the request IS rather than what it is not.
 *
 * A PREFETCH also carries `rsc`, and a prefetch is not a navigation: the user
 * may never follow the link. So `next-router-prefetch`
 * (`NEXT_ROUTER_PREFETCH_HEADER`) must be ABSENT. Counting prefetches would
 * inflate this denominator exactly as counting redirects would inflate the
 * other, and in the same direction — making dropped beacons look like a quiet
 * app.
 *
 * AND ONLY ONES ACTUALLY SERVED. A request redirected to `/login` renders no
 * app and emits no vitals, so counting it would inflate the denominator and
 * make the ratio read as dropped beacons. The middleware already computes
 * `isPassThrough` for its own reasons; that is the term.
 *
 * ─── THE KNOWN FLOOR, stated rather than hidden ───────────────────────────
 *
 * A client that sends no `Sec-Fetch-Dest` is not counted. Every browser that
 * can run the `web-vitals` library sends it (Chrome 80+, Firefox 90+, Safari
 * 16.4+), so the two populations very nearly agree — but "very nearly" is not
 * "exactly", and a ratio above 1 beacon-set per counted load is the shape that
 * would reveal it. Asserted as deliberate in
 * `tests/unit/observability/document-load-denominator.test.ts` rather than
 * left as an accident.
 *
 * @module lib/observability/vital-route
 */

/**
 * Segments that are identifiers rather than route structure: a cuid, a uuid,
 * or a bare number.
 */
const ID_SEGMENT =
    /^(c[a-z0-9]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

/**
 * Page prefixes whose NEXT path segment is a BEARER CAPABILITY, mapped to the
 * literal sibling pages that are not (#5130).
 *
 * The middleware logs one `document_load` line per page load carrying the
 * normalized route, and it runs on public paths: `/invite/` and `/audit/shared`
 * are pass-through in `src/lib/auth/guard.ts`, so `isPassThrough` is true and
 * the line is written. The tokens in those paths are the raw capability —
 * audit-pack share tokens are `randomBytes(32).toString('hex')` and invite
 * tokens `randomBytes(32).toString('base64url')`, and the database deliberately
 * stores only a SHA-256 hash of each. `ID_SEGMENT` collapsed neither: a hex
 * token matches `c[a-z0-9]{20,}` only when it happens to start with `c` (1 in
 * 16), and a base64url token almost always contains `-` or `_` and so never
 * matches. So roughly 94% of share tokens and nearly every invite token were
 * written to the container log in plaintext, readable for the token's whole
 * validity window by anyone who can read `docker logs`.
 *
 * This is an explicit list because the three prefixes are then handled
 * DETERMINISTICALLY rather than probabilistically — see `OPAQUE_SEGMENT` below
 * for the general backstop, which is the part that covers a prefix nobody
 * remembered to add here.
 *
 * The values are the literal pages that are NOT tokens. `/invite/result` and
 * `/invite/org` are real pages sitting beside `/invite/[token]`, so a blanket
 * "the segment after /invite is a token" would destroy both labels. An unknown
 * segment at one of these parents collapses to `[token]`: a new literal page
 * added without updating this list loses label fidelity, which is the safe
 * direction — the unsafe direction prints a credential.
 */
const CAPABILITY_PARENTS: ReadonlyMap<string, readonly string[]> = new Map([
    ['/audit/shared', [] as readonly string[]],
    ['/invite', ['org', 'result'] as readonly string[]],
    ['/invite/org', [] as readonly string[]],
]);

/**
 * A segment long enough and mixed enough to be a secret rather than a word.
 *
 * The general backstop for a token-bearing public path that is added later and
 * never registered in `CAPABILITY_PARENTS`. The threshold is measured, not
 * guessed: `src/app` currently holds 485 literal route segments, 24 of them 20
 * characters or longer (`http-message-signatures-directory`,
 * `vendor-assessment-templates`, `identity-account-protection`, …). Requiring a
 * DIGIT is what separates those from a credential — exactly one of the 24
 * carries a digit or uppercase (`ServiceProviderConfig`, which has no digit),
 * and every segment that does contain a digit (`a2a`, `nis2-gap`, `nis2-assessment`,
 * `a2a-signing-key`, `v2`) is far below 20 characters.
 *
 * So this collapses no real route label today, while catching essentially every
 * credential: a 64-char hex token contains a digit with probability ~1, and a
 * 43-char base64url token with probability ~0.9997. That residual is why the
 * three known prefixes above are listed explicitly rather than left to this.
 *
 * NOTE: a bare length rule — which is the obvious spelling — would collapse all
 * 24 of those real segments and silently destroy their route series.
 */
const OPAQUE_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{20,}$/;

/**
 * Collapse a page pathname to a bounded route label:
 *   `/t/acme/controls/ckxyz...`  →  `/t/[tenant]/controls/[id]`
 *   `/t/acme/dashboard`          →  `/t/[tenant]/dashboard`
 * Keeps metric/label cardinality finite regardless of tenant count or row ids.
 */
export function normalizeVitalRoute(pathname: string): string {
    const path = (pathname || '/').split('?')[0].split('#')[0];
    const parts = path.split('/');
    const out: string[] = [];
    for (const seg of parts) {
        if (seg === '') {
            out.push(seg);
            continue;
        }
        // The segment immediately after `/t/` is the tenant slug.
        if (out[out.length - 1] === 't') {
            out.push('[tenant]');
            continue;
        }
        // A bearer capability never reaches the log (#5130).
        //
        // ORDER IS LOAD-BEARING. This runs BEFORE `ID_SEGMENT`, so a known
        // capability parent always yields `[token]` whatever the token's shape.
        // With the id check first, a hex share token that happened to start
        // with `c` matched `c[a-z0-9]{20,}` and labelled `/audit/shared/[id]` —
        // safe, but it split ONE route across two label values on a 1-in-16
        // coin flip, which is precisely the cardinality this function exists to
        // keep stable.
        const literals = CAPABILITY_PARENTS.get(out.join('/'));
        if (literals !== undefined && !literals.includes(seg)) {
            out.push('[token]');
            continue;
        }
        // A row id stays `[id]`, as it always has: checked before the general
        // credential rule so a cuid — 25 characters, carrying digits — keeps
        // its existing label rather than being reclassified as a secret.
        if (ID_SEGMENT.test(seg)) {
            out.push('[id]');
            continue;
        }
        if (OPAQUE_SEGMENT.test(seg)) {
            out.push('[token]');
            continue;
        }
        out.push(seg);
    }
    let route = out.join('/') || '/';
    if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1);
    return route;
}

/** The log message the denominator is emitted under. */
export const DOCUMENT_LOAD_MSG = 'document_load';

/**
 * The soft-navigation counter's message (#4195).
 *
 * Its own line rather than a field on `document_load`, so the two questions in
 * the header stay separable: a reader summing `document_load` gets visits, and
 * summing both gets beacon-set opportunities. One message with a kind field
 * would make every existing query of the first silently wrong.
 */
export const SOFT_NAVIGATION_MSG = 'soft_navigation';

/**
 * The route label to count this request under, or `null` not to count it.
 *
 * Pure, and deliberately so: the middleware it is called from can only be
 * tested structurally — by grepping its source for spellings — because of its
 * auth dependencies, and a spelling assertion against a double that accepts
 * anything is how #3554 stayed green for seven days. Everything that can be
 * decided without a request object is decided here, where it can be asserted
 * on behaviour.
 */
export function documentLoadRoute(input: {
    /** The request's `Sec-Fetch-Dest` header, or null if absent. */
    readonly fetchDest: string | null;
    readonly pathname: string;
    /** Did the middleware let this through, rather than redirect it? */
    readonly passedThrough: boolean;
}): string | null {
    if (!input.passedThrough) return null;
    if (input.fetchDest !== 'document') return null;
    // Defensive: an API path is not a page even if something asks for it as a
    // document, and counting one would put a non-page label in the series.
    if (input.pathname.startsWith('/api/')) return null;
    return normalizeVitalRoute(input.pathname);
}

/**
 * The route label for a request that represents a CLIENT-SIDE navigation, or
 * `null` when it represents none (#4195).
 *
 * Pure for the same reason as `documentLoadRoute`: the middleware can only be
 * tested by grepping its own source, so every decision that does not need a
 * request object is made here, where it can be asserted on behaviour.
 *
 * See the header for why the discriminator is Next's `rsc` header rather than
 * `Sec-Fetch-Dest: empty`, and why a prefetch does not count.
 */
export function softNavigationRoute(input: {
    /** The request's `rsc` header, or null if absent. */
    readonly rsc: string | null;
    /** The request's `next-router-prefetch` header, or null if absent. */
    readonly routerPrefetch: string | null;
    readonly pathname: string;
    /** Did the middleware let this through, rather than redirect it? */
    readonly passedThrough: boolean;
}): string | null {
    if (!input.passedThrough) return null;
    // PRESENT, whatever its value. Next sends `rsc: 1`, but the contract is the
    // header's presence; pinning the value would make a future `rsc: 2` read as
    // no navigation at all, which is the silent direction.
    if (input.rsc === null) return null;
    // A prefetch is not a navigation.
    if (input.routerPrefetch !== null) return null;
    // An API path is not a page, for the same reason as the other counter.
    if (input.pathname.startsWith('/api/')) return null;
    return normalizeVitalRoute(input.pathname);
}
