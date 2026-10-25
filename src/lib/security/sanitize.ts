/**
 * Server-side HTML sanitisation (Epic C.5).
 *
 * Every API write path that accepts user-supplied rich text routes
 * through one of the helpers below BEFORE the value is persisted. This
 * is the durable line of defence — render-time sanitisation in React
 * is helpful but not sufficient: a single missed `dangerouslySetInner-
 * HTML` consumer would otherwise turn a stored payload into a stored
 * XSS vector. Sanitising at write time means even off-app surfaces
 * (PDF export, audit pack share link, future SDKs reading the row
 * verbatim) inherit the same safety.
 *
 * Two profiles. Pick by the call-site's intent:
 *
 *   - `sanitizeRichTextHtml(input)` — for surfaces that render HTML
 *     (policy `contentText` when `contentType === 'HTML'`,
 *     comment bodies when we eventually allow HTML formatting).
 *     Allows a deliberately small set of formatting tags + safe links.
 *
 *   - `sanitizePlainText(input)` — for surfaces that render plain text
 *     (titles, single-line descriptions, comment bodies today). Strips
 *     ALL tags AND HTML-entity-decodes so a stored `&lt;script&gt;`
 *     can't roundtrip back into a `<script>` somewhere downstream.
 *
 * And one helper for a value that is a URL rather than prose:
 *
 *   - `sanitizeUrlText(input)` — percent-encodes the characters that can
 *     open markup or end an attribute. `sanitizePlainText` must NOT be
 *     used on a URL: see that helper for why it corrupts query strings.
 *
 * Library choice
 * --------------
 *   `sanitize-html` over DOMPurify+jsdom because it runs natively on
 *   Node without a DOM polyfill, bundles smaller, and exposes a
 *   declarative allowlist API that's simpler to review in code review.
 *   It is the de-facto Node.js sanitiser used by GitHub, npm, Sentry,
 *   and others.
 */

import sanitizeHtml from 'sanitize-html';

// ─── Rich-text profile ──────────────────────────────────────────────

/**
 * Tags allowed in the rich-text profile. Headings, paragraphs, lists,
 * inline emphasis, links, code blocks, blockquotes, tables. No
 * `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<form>`,
 * `<input>`, no SVG, no MathML. The `sanitize-html` defaults already
 * exclude these, but we re-state the allowed set explicitly so a
 * library default change can't quietly widen it.
 */
const RICH_TEXT_ALLOWED_TAGS: string[] = [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'u', 's', 'sub', 'sup', 'mark',
    'ul', 'ol', 'li',
    'blockquote',
    'code', 'pre',
    'a',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'div', 'span',
];

/**
 * Per-tag attribute allowlist. Anything not listed here is stripped.
 * Notably, NO `style`, `class`, or any `on*` handlers anywhere. The
 * only `id`s permitted are on headings — inert anchor targets for the
 * policy Table of Contents (`<a href="#...">`). No other tag may carry
 * an `id`.
 */
const RICH_TEXT_ALLOWED_ATTRS: Record<string, string[]> = {
    a: ['href', 'title', 'rel', 'target'],
    h1: ['id'], h2: ['id'], h3: ['id'], h4: ['id'], h5: ['id'], h6: ['id'],
    th: ['scope', 'colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    code: ['data-language'],
    pre: ['data-language'],
};

/**
 * URL schemes accepted on `href` and friends. Note the deliberate
 * absence of `javascript:`, `data:` (except `data:image/...` which we
 * also exclude — embed images via the upload API instead), and
 * `vbscript:`. Relative URLs are accepted via
 * `allowProtocolRelative: false` + the schemes below being the only
 * legal protocol prefixes.
 */
const RICH_TEXT_ALLOWED_SCHEMES: string[] = ['http', 'https', 'mailto', 'tel'];

/**
 * Sanitise an HTML rich-text payload before persisting it.
 *
 * Behaviour:
 *   - Allowed tags: headings, paragraphs, lists, basic inline marks,
 *     links (`http`, `https`, `mailto`, `tel`), code blocks, tables.
 *   - All other tags are stripped (their text content is preserved).
 *   - All attributes outside the per-tag allowlist are stripped — no
 *     `style`, `class`, `id`, `on*`.
 *   - All `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>` are
 *     dropped along with their text content (XSS sinks).
 *   - Links get `rel="noopener noreferrer"` and `target` gets coerced
 *     to `_blank` only when explicitly set — a bare link stays
 *     same-tab.
 *   - Returns `''` for `null` / `undefined` so callers can pipe an
 *     optional field through unconditionally.
 */
export function sanitizeRichTextHtml(input: string | null | undefined): string {
    if (input == null) return '';
    if (typeof input !== 'string') return '';
    return sanitizeHtml(input, {
        allowedTags: RICH_TEXT_ALLOWED_TAGS,
        allowedAttributes: RICH_TEXT_ALLOWED_ATTRS,
        allowedSchemes: RICH_TEXT_ALLOWED_SCHEMES,
        allowedSchemesAppliedToAttributes: ['href'],
        allowProtocolRelative: false,
        // Drop disallowed tags AND their text content for known XSS
        // sinks; for everything else, keep the inner text. This
        // matches user intent ("they tried to insert <script> with
        // text — strip the script AND don't ship the script body as
        // plain text") while preserving e.g. `<custom-tag>hi</custom-tag>`
        // → `hi`.
        nonTextTags: ['script', 'style', 'textarea', 'noscript', 'iframe', 'object', 'embed'],
        // Coerce `<a target="...">`: keep target only when it's a
        // recognised value, and always pair with a safe rel.
        transformTags: {
            a: (tagName, attribs) => {
                const next: Record<string, string> = { ...attribs };
                // Force-safe relationship attrs.
                next.rel = 'noopener noreferrer';
                if (next.target && next.target !== '_blank' && next.target !== '_self') {
                    delete next.target;
                }
                return { tagName, attribs: next };
            },
        },
    });
}

// ─── Plain-text profile ─────────────────────────────────────────────

/**
 * Decode the HTML entities an attacker could use to smuggle a `<` or `>`
 * past a tag-stripper: named (`&lt;`), decimal-numeric (`&#60;`) and
 * hex-numeric (`&#x3c;`). `&amp;` is decoded LAST so a single pass turns
 * `&amp;lt;` into `&lt;` (not `<`) — the caller loops, peeling one layer per
 * pass, so multi-level encodings still fully resolve. Invalid code points are
 * left verbatim rather than throwing.
 */
function decodeHtmlEntities(s: string): string {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => codePointOrRaw(parseInt(hex, 16), m))
        .replace(/&#(\d+);/g, (m, dec: string) => codePointOrRaw(parseInt(dec, 10), m))
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;|&#39;|&#x27;/gi, "'")
        .replace(/&#47;|&#x2f;/gi, '/')
        .replace(/&amp;/gi, '&');
}

function codePointOrRaw(cp: number, raw: string): string {
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        return raw;
    }
    return String.fromCodePoint(cp);
}

/**
 * Strip all HTML from a field that has NO formatting (title, label,
 * single-line description, comment body).
 *
 * SECURITY — entity order matters. The naive "strip tags, THEN decode
 * entities" is a stored-XSS double-unescape: `sanitize-html` leaves an
 * entity-encoded `&lt;script&gt;` untouched (it isn't a tag), and decoding
 * afterwards reconstitutes a live `<script>` — the exact element the
 * sanitiser exists to remove. So an attacker only has to pre-encode their
 * payload to defeat it.
 *
 * The fix DECODES FIRST, then strips, looping until the value stabilises so
 * that (a) `&lt;script&gt;` and even multi-level `&amp;lt;script&amp;gt;`
 * materialise into real tags and get removed, exactly like a raw
 * `<script>`, and (b) the final value, once decoded, can no longer form any
 * strippable tag (at the fixed point `sanitizeHtml(decode(x)) === x`, so
 * `decode(x)` is tag-free). Innocuous entities (`&amp;`, `&quot;`, `&#39;`)
 * still resolve to their readable characters.
 */
export function sanitizePlainText(input: string | null | undefined): string {
    if (input == null) return '';
    if (typeof input !== 'string') return '';

    const strip = (s: string) =>
        sanitizeHtml(decodeHtmlEntities(s), { allowedTags: [], allowedAttributes: {} });

    let current = input;
    let next = strip(current);
    // Peel one encoding layer per pass until stable. The bound is a backstop
    // against a pathological input; a handful of layers resolves any real one.
    for (let i = 0; next !== current && i < 8; i++) {
        current = next;
        next = strip(current);
    }
    if (next !== current) {
        // Did not converge — return the sanitiser's (entity-encoded, tag-free)
        // form, which is always safe, over a possibly-unsafe decode.
        return next;
    }
    // Fixed point: `current` is tag-free even after decoding, so the decoded
    // form is both safe AND the readable literal text.
    return decodeHtmlEntities(current);
}

// ─── URL profile ────────────────────────────────────────────────────

/**
 * Characters a URL may not contain unencoded (RFC 3986) that HTML reads as
 * markup or as the end of an attribute value: `<` `>` `"` and the backtick,
 * whitespace, and the C0 controls and DEL. A browser percent-encodes them
 * before it sends a request, so encoding them here leaves the link pointing
 * where it pointed. `'` is deliberately absent: RFC 3986 allows it, and an
 * encoded `%27` is not, strictly, the same URL.
 */
const URL_MARKUP_CHARS = /[<>"`\s\u0000-\u001f\u007f]/g;

/**
 * Neutralise markup in a user-supplied URL without changing where it points.
 *
 * WHY NOT `sanitizePlainText`. That helper parses its input as HTML, and an
 * HTML parser decodes the legacy entities that need no closing semicolon
 * inside text — `&reg`, `&para`, `&sect`, `&times`, `&not`, `&copy`, `&lt`
 * and about a hundred more. In a URL `&` is the query separator, so
 * `?lang=en&region=us` came back as `?lang=en®ion=us`, `&param=` as `¶m=`
 * and `&timestamp=` as `×tamp=`: a stored link that goes somewhere else.
 *
 * So this does not parse at all. It trims, then percent-encodes every
 * {@link URL_MARKUP_CHARS} character. The result contains no `<` or `>`, so no
 * renderer can find a tag in it, and no `"` or whitespace, so it cannot end a
 * double-quoted or unquoted attribute. `&` and any entity are left exactly as
 * typed: in every HTML context an entity is text, never markup.
 *
 * It does NOT judge the scheme. A `javascript:` link survives this, as it
 * survives `sanitizePlainText`; refusing to render one is `normaliseHref` in
 * `@/lib/security/safe-url`.
 *
 * Returns `''` for `null` / `undefined` / a non-string, like the other
 * helpers.
 */
export function sanitizeUrlText(input: string | null | undefined): string {
    if (input == null) return '';
    if (typeof input !== 'string') return '';
    return input.trim().replace(URL_MARKUP_CHARS, (c) => encodeURIComponent(c));
}

// ─── Convenience helpers ────────────────────────────────────────────

/**
 * Pick the right sanitiser for a policy version's content based on
 * its declared content type. `MARKDOWN` gets the plain-text treatment
 * because the renderer (the markdown engine) is responsible for
 * escaping; storing literal HTML inside a Markdown field would be a
 * silent bypass of the markdown sanitiser.
 */
export function sanitizePolicyContent(
    contentType: 'HTML' | 'MARKDOWN' | 'EXTERNAL_LINK',
    content: string | null | undefined,
): string {
    if (content == null) return '';
    if (contentType === 'HTML') return sanitizeRichTextHtml(content);
    return sanitizePlainText(content);
}
