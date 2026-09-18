/**
 * Where "back" goes — as a pure function, deliberately.
 *
 * This logic used to live inline in `BackAffordance`, which made it
 * unreachable from a test. The guard that was supposed to cover it
 * (`tests/guards/rq4-back-link-fixes.test.ts`) therefore asserted
 * `expect(source).toMatch(/referrerIsSibling/)` — it checked that an
 * IDENTIFIER APPEARED IN THE FILE. A test like that cannot fail when the
 * behaviour is wrong, and it did not: a whole class of circular back links
 * shipped underneath it.
 *
 * So the resolution is pure and exported, and the guard drives it over every
 * (page, referrer) pair rather than reading the source.
 *
 * ORDER OF PREFERENCE:
 *   1. an explicit override
 *   2. the referrer — the page you actually came from — unless it would take
 *      you sideways (sibling) or downwards (descendant)
 *   3. the IA-canonical parent
 *   4. nothing, in which case the caller renders no link at all, which is
 *      the documented contract: better no back link than a descending one.
 */
import {
    resolveCanonicalParent,
    referrerIsDescendant,
    type CanonicalParent,
} from '@/lib/nav/canonical-parents';

export interface BackDestinationInput {
    /** The page currently rendered, tenant-prefixed. */
    pathname: string;
    /** The in-tenant path the user navigated from, or null. */
    referrer: string | null;
    tenantSlug: string | null;
    /** Explicit destination, wins over everything. */
    override?: CanonicalParent;
    /** When true, no canonical fallback — referrer or nothing. */
    noFallback?: boolean;
    /** Produces the label for a referrer-derived destination. */
    labelFor: (pathname: string) => string;
}

export function resolveBackDestination({
    pathname,
    referrer,
    tenantSlug,
    override,
    noFallback,
    labelFor,
}: BackDestinationInput): CanonicalParent | null {
    if (override) return override;
    if (!tenantSlug) return null;

    const canonical = noFallback
        ? null
        : resolveCanonicalParent(pathname, tenantSlug);

    // Sideways: both pages share a canonical parent (stepping /assets/A ->
    // /assets/B). Go to the shared parent instead of back to the sibling.
    const referrerIsSibling =
        referrer != null &&
        canonical != null &&
        resolveCanonicalParent(referrer, tenantSlug)?.href === canonical.href;

    // Downwards: the referrer sits below this page in the IA. NOT gated on
    // `canonical != null` — the sibling check above is, which is why the two
    // `noFallback` pages have only one live guard today. This one stays live
    // there too.
    const referrerDescends =
        referrer != null && referrerIsDescendant(referrer, pathname, tenantSlug);

    if (
        referrer &&
        referrer !== pathname &&
        !referrerIsSibling &&
        !referrerDescends
    ) {
        return { href: referrer, label: labelFor(referrer) };
    }
    return canonical;
}
