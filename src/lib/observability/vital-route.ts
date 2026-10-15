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
 * ─── WHAT IS COUNTED, AND WHAT THAT MEANS ─────────────────────────────────
 *
 * A browser's web-vitals fire ONCE PER DOCUMENT LOAD, not per client-side
 * navigation — `useReportWebVitals` subscribes to six per-document callbacks
 * (see the KNOWN_VITALS note in `web-vitals.ts`). So the matching denominator
 * is document loads, and the discriminator is `Sec-Fetch-Dest: document`: an
 * RSC payload or a prefetch arrives as `empty`, an image as `image`.
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
        out.push(ID_SEGMENT.test(seg) ? '[id]' : seg);
    }
    let route = out.join('/') || '/';
    if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1);
    return route;
}

/** The log message the denominator is emitted under. */
export const DOCUMENT_LOAD_MSG = 'document_load';

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
