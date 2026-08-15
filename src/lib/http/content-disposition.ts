/**
 * `Content-Disposition` filenames — one sanitiser, one header builder.
 *
 * ## The bug this closes
 *
 * Seventeen routes build the header by interpolating a filename into a quoted
 * string:
 *
 *     `attachment; filename="${name}"`
 *
 * Exactly one of them sanitised `name`. The rest took a value that a tenant
 * user had typed — an audit-pack name, an uploaded file's original name — and
 * dropped it in whole. Three characters matter:
 *
 *   - `"`  closes the quoted-string early, letting the rest of the value be
 *          read as further header PARAMETERS;
 *   - CR / LF  terminate the header line entirely (response splitting), which
 *          is how a filename becomes an injected header or a second response.
 *
 * `packs.ts` is the instructive near-miss: it did
 * `pack.name.replace(/\s+/g, '-')`. That looks defensive and removes CR and LF
 * (both are `\s`) — but quotes are untouched, so it neutralised the loud half
 * of the problem and left the quiet half. Partial sanitisation reads as
 * sanitisation in review.
 *
 * ## Why strip rather than encode
 *
 * RFC 6266 offers `filename*=UTF-8''…` percent-encoding, which preserves
 * non-ASCII names properly. That is the better long-term answer and this
 * helper is where it would go. Today it deliberately matches the behaviour of
 * the one route that already got this right (evidence download), because
 * changing what users see in their Downloads folder is a product decision, and
 * closing an injection is not.
 *
 * @see tests/unit/content-disposition.test.ts
 */

/** Fallback when a name sanitises down to nothing. */
const FALLBACK = 'download';

/**
 * Make a filename safe to interpolate into a quoted `Content-Disposition`
 * parameter.
 *
 * Strips every character outside printable ASCII — which covers CR, LF, NUL
 * and the rest of the C0 range in one pass — then neutralises the double
 * quote. Both steps are load-bearing; neither alone is sufficient.
 */
export function sanitizeContentDispositionFilename(name: string | null | undefined): string {
    const cleaned = (name ?? '')
        // Non-printable-ASCII → `_`. This is the CR/LF defence: response
        // splitting needs a raw newline, and there is no newline left.
        .replace(/[^\x20-\x7E]/g, '_')
        // The quote that would end the quoted-string. `'` is a legal filename
        // character on every platform we serve, so this loses nothing.
        .replace(/"/g, "'")
        // A leading/trailing space or dot round-trips badly through Windows
        // and through some proxies; trim rather than surprise the user.
        .replace(/^[\s.]+|[\s.]+$/g, '');

    return cleaned || FALLBACK;
}

/**
 * Build the whole header value. Prefer this over hand-interpolating, so the
 * quoting and the sanitising cannot drift apart at a call site.
 *
 * @param disposition `attachment` (default) forces a download; `inline` lets
 *   the browser render it. Never derive this from user input — an `inline`
 *   HTML file is stored XSS on our origin.
 */
export function contentDispositionHeader(
    name: string | null | undefined,
    disposition: 'attachment' | 'inline' = 'attachment',
): string {
    return `${disposition}; filename="${sanitizeContentDispositionFilename(name)}"`;
}
