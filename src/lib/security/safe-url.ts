/**
 * Safe URL utilities.
 *
 * Used to render user-controlled URLs (vendor websites, privacy
 * policies, evidence external-URLs, etc.) as `<a href>` without
 * introducing XSS (`javascript:`) or reverse-tabnabbing
 * (`target="_blank"` without `rel="noopener"`).
 *
 * Rules enforced:
 *   - `javascript:`, `data:`, `vbscript:` hrefs are blocked.
 *   - Relative URLs and `http(s)://` URLs pass through verbatim.
 *   - All external links emit `rel="noopener noreferrer"` whenever
 *     `target="_blank"` is set.
 *
 * The guard is structural (the hook returns `null` when the URL is
 * unsafe) so callers can `{safeHref && <a …>}` without having to
 * remember the security story at every site.
 */

const DANGEROUS_PROTOCOLS = /^\s*(javascript|data|vbscript|file):/i;

/**
 * Control characters, tab, newline and DEL. A browser's URL parser drops tab
 * and newline wherever they appear and ignores leading control characters,
 * so `java\tscript:` runs as `javascript:`. The protocol test reads the URL
 * as the browser will.
 */
const URL_IGNORED_CHARS = /[\u0000-\u001F\u007F]/g;

export function isSafeHref(raw: string | null | undefined): boolean {
    if (!raw) return false;
    if (DANGEROUS_PROTOCOLS.test(raw.replace(URL_IGNORED_CHARS, ''))) return false;
    return true;
}

/**
 * Normalise a user-supplied URL for rendering. Returns null when the
 * URL is missing or uses a dangerous protocol — callers should not
 * render a link in that case.
 */
export function normaliseHref(raw: string | null | undefined): string | null {
    if (!isSafeHref(raw)) return null;
    return (raw ?? "").trim();
}

/**
 * Canonical anchor attrs for opening a user-supplied URL in a new
 * tab. Satisfies WCAG 2.1 + reverse-tabnabbing mitigation in one call.
 */
export const EXTERNAL_LINK_ATTRS = {
    target: "_blank" as const,
    rel: "noopener noreferrer" as const,
};
