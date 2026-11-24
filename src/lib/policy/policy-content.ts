/**
 * Policy content enrichment — heading anchors + an auto Table of Contents.
 *
 * Two structural features layer on top of the stored HTML policy body
 * WITHOUT changing what's persisted:
 *
 *   - **Heading anchors** — every `<h1>`–`<h3>` gets a stable, unique
 *     slug `id` so the table of contents can link to it.
 *   - **Auto Table of Contents** — a `Contents` nav built from the
 *     document headings, inserted after the first page break (`<hr>`)
 *     if present, else after the first heading. The document title
 *     (a leading `<h1>`) is excluded from the list.
 *
 * Page breaks themselves are plain `<hr>` elements (authored via the
 * editor's "Page break" button); they're styled as a labelled divider
 * on screen and become real page breaks in print / PDF.
 *
 * Implementation note: this parses the body with the DOM (`DOMParser`)
 * rather than regex — correct HTML handling AND no "regex HTML filter"
 * pitfalls. It runs on ALREADY-SANITISED HTML and on the CLIENT only
 * (the policy view fetches content client-side, so the heavy lifting
 * happens after hydration); in any environment without a DOM it returns
 * the input unchanged. All generated text is set via `textContent`, so
 * the browser serialiser escapes it — no injection surface is added.
 */

import { marked } from 'marked';

export interface PolicyHeading {
    level: number;
    text: string;
    id: string;
}

const HAS_DOM = typeof DOMParser !== 'undefined';

/**
 * Convert a MARKDOWN policy body to HTML so it renders with the same
 * document styling (headers, lists, page breaks) as native-HTML policies.
 * The output is UNSANITISED — the caller MUST run it through
 * `sanitizeRichTextHtml` (then `enrichPolicyHtml`) before rendering. Uses
 * the `marked` CommonMark/GFM parser — no regex HTML construction.
 */
export function renderPolicyMarkdown(md: string | null | undefined): string {
    if (!md || !md.trim()) return '';
    return marked.parse(md, { gfm: true, breaks: false, async: false });
}

/** URL-safe slug from already-plain heading text. Falls back to `section`. */
export function slugifyHeading(text: string): string {
    const base = text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
        .replace(/-+$/g, '');
    return base || 'section';
}

/** Collapse whitespace in an element's text content. */
function headingText(el: Element): string {
    return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Assign a stable, unique `id` to every h1–h3 in `body` (preserving a
 * usable author-set id) and return the heading list in document order.
 * Mutates the elements in place.
 */
function annotateHeadings(body: HTMLElement): PolicyHeading[] {
    const seen = new Set<string>();
    const headings: PolicyHeading[] = [];
    for (const el of Array.from(body.querySelectorAll('h1, h2, h3'))) {
        const text = headingText(el);
        if (!text) continue; // empty heading — no anchor
        const level = Number(el.tagName[1]);

        const existing = el.getAttribute('id') ?? '';
        let id = existing && !seen.has(existing) ? existing : '';
        if (!id) {
            const slug = slugifyHeading(text);
            let candidate = slug;
            let n = 2;
            while (seen.has(candidate)) candidate = `${slug}-${n++}`;
            id = candidate;
        }
        seen.add(id);
        el.setAttribute('id', id);
        headings.push({ level, text, id });
    }
    return headings;
}

/** Assign heading ids; returns the rewritten HTML + the heading list. */
export function assignHeadingIds(html: string): { html: string; headings: PolicyHeading[] } {
    if (!HAS_DOM) return { html, headings: [] };
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const headings = annotateHeadings(doc.body);
    return { html: doc.body.innerHTML, headings };
}

/**
 * The two strings the Contents block shows. The page passes them from its
 * message catalogue, so a Bulgarian page's TOC is not labelled in English;
 * the English default is for callers with no translator (and the tests).
 */
export interface PolicyTocLabels {
    /** The visible heading above the list. */
    title: string;
    /** The `<nav>` landmark's accessible name. */
    ariaLabel: string;
}

const DEFAULT_TOC_LABELS: PolicyTocLabels = { title: 'Contents', ariaLabel: 'Table of contents' };

/** Build the Contents <nav> from a heading list, using the given document. */
function buildTocNav(doc: Document, headings: PolicyHeading[], labels: PolicyTocLabels): HTMLElement {
    const nav = doc.createElement('nav');
    nav.className = 'policy-toc';
    nav.setAttribute('aria-label', labels.ariaLabel);
    nav.setAttribute('data-testid', 'policy-toc');

    const title = doc.createElement('p');
    title.className = 'policy-toc-title';
    title.textContent = labels.title;
    nav.appendChild(title);

    const ul = doc.createElement('ul');
    for (const h of headings) {
        const li = doc.createElement('li');
        li.className = `policy-toc-l${h.level}`;
        const a = doc.createElement('a');
        a.setAttribute('href', `#${h.id}`);
        a.textContent = h.text; // serialiser escapes — no injection
        li.appendChild(a);
        ul.appendChild(li);
    }
    nav.appendChild(ul);
    return nav;
}

/**
 * Enrich a sanitised HTML policy body with heading anchors + an
 * auto-generated Table of Contents. Returns the HTML unchanged when
 * there aren't at least two linkable sections (a TOC would be noise),
 * or when no DOM is available (server — enrichment happens on the
 * client after the content loads).
 *
 * Placement, matching the reference layout (Title → page break →
 * Contents): the TOC is inserted immediately after the first `<hr>`
 * page break when present, otherwise right after the first heading.
 */
export function enrichPolicyHtml(
    html: string | null | undefined,
    labels: PolicyTocLabels = DEFAULT_TOC_LABELS,
): string {
    if (!html) return '';
    if (!HAS_DOM) return html;

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.body;
    const headings = annotateHeadings(body);

    // Exclude a leading <h1> — that's the document title, not a section.
    const eligible = headings[0]?.level === 1 ? headings.slice(1) : headings;
    if (eligible.length < 2) return body.innerHTML;

    const nav = buildTocNav(doc, eligible, labels);

    const firstHr = body.querySelector('hr');
    if (firstHr?.parentNode) {
        firstHr.parentNode.insertBefore(nav, firstHr.nextSibling);
    } else {
        const firstHeading = body.querySelector('h1, h2, h3');
        if (firstHeading?.parentNode) {
            firstHeading.parentNode.insertBefore(nav, firstHeading.nextSibling);
        } else {
            body.insertBefore(nav, body.firstChild);
        }
    }
    return body.innerHTML;
}
