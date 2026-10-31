/**
 * Where a sign-in may send the browser afterwards: a path on this site, or
 * nowhere in particular.
 *
 * Client-safe on purpose (no imports). The sign-in page is a client component
 * and needs the same rule as the middleware and the SSO callbacks, which is
 * why this lives apart from `guard.ts` (that file imports `next/server`).
 */

/** An origin nothing can be served from, used only to resolve a path. */
const PROBE_ORIGIN = 'https://redirect-path.invalid';

/**
 * A browser treats `\` as `/`, and drops tab, CR and LF from a URL, so
 * `/\evil.com` and `/<TAB>/evil.com` are both `//evil.com` by the time the
 * browser reads them: another host. Any control character is refused with them.
 */
const ESCAPING_CHARS = /[\\\u0000-\u001f\u007f]/;

/**
 * Sanitize a redirect path to prevent open-redirect attacks.
 *
 * Returns the path, query and fragment of `next` when `next` is a path on this
 * site, and `'/'` for anything else: an absolute or protocol-relative URL, a
 * `javascript:` URL, a relative path, and any path a browser would read as
 * another host. The input is URL-decoded once first, so an encoded escape is
 * judged by what it decodes to.
 */
export function sanitizeRedirectPath(next: string | null | undefined): string {
    if (!next) return '/';

    let decoded: string;
    try {
        decoded = decodeURIComponent(next);
    } catch {
        return '/';
    }

    if (!decoded.startsWith('/') || decoded.startsWith('//')) return '/';
    if (decoded.includes('://') || ESCAPING_CHARS.test(decoded)) return '/';

    // The last word goes to the URL parser itself: whatever it makes of the
    // path, it must still be on the origin the path was resolved against.
    let url: URL;
    try {
        url = new URL(decoded, PROBE_ORIGIN);
    } catch {
        return '/';
    }
    if (url.origin !== PROBE_ORIGIN) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Where the sign-in page sends the browser once someone has signed in.
 *
 * `requested` is the destination the page was opened with: `?callbackUrl=`
 * from a link, or `?next=` from the middleware, which bounces a signed-out
 * visitor here. Nothing usable means the workspace picker, which sends a
 * person with one workspace straight to its dashboard.
 */
export function postSignInPath(requested: string | null | undefined): string {
    const safe = sanitizeRedirectPath(requested);
    return safe === '/' ? '/tenants' : safe;
}
